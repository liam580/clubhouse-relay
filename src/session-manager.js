'use strict';

// Polls Optix for the currently-in-progress booking on this bay's resource and
// opens/closes a `sessions` row in Supabase accordingly. Hands a `{session_id,
// player_id}` tag to the persistence layer via `getCurrentTag()` so each shot
// is tagged in real time.
//
// State machine:
//   NO_SESSION  ── poll finds active booking ──▶  SESSION_OPEN
//   SESSION_OPEN ── poll finds different booking ──▶  close + open new (rare)
//   SESSION_OPEN ── poll finds no booking ──▶  NO_SESSION
//   SESSION_OPEN ── inactivity timer (10 min) ──▶  NO_SESSION (safety net)
//
// On open: upsert player, insert session, backfill last 60s of NULL shots.
// On close: finalize ended_at + shot_count from Supabase count.
// Failures (Optix poll, Supabase calls) are logged but do not crash the
// process. The relay's forward TCP path is never blocked by anything here.

const STATE = { NO_SESSION: 'NO_SESSION', SESSION_OPEN: 'SESSION_OPEN', STOPPED: 'STOPPED' };

function createSessionManager({ config, logger, optixClient, supabase }) {
  const bayNumber = config.bay.number;
  const resourceId = config.bay.optixResourceId;
  const pollIntervalMs = config.optix?.pollIntervalMs || 30000;
  const inactivityMs = config.session?.inactivityTimeoutMs || 600000;
  const backfillMs = config.session?.backfillWindowMs || 60000;

  const enabled = Boolean(
    optixClient?.enabled &&
    supabase?.enabled &&
    resourceId
  );

  let state = STATE.NO_SESSION;
  let currentSession = null;       // { id, player_id, optix_booking_id }
  let pollTimer = null;
  let inactivityTimer = null;
  let pollInFlight = false;
  let stopped = false;
  let _pollResolver = null;        // for tests

  const getCurrentTag = () => {
    if (state !== STATE.SESSION_OPEN || !currentSession) return null;
    return { session_id: currentSession.id, player_id: currentSession.player_id };
  };

  function noteShot() {
    if (state !== STATE.SESSION_OPEN) return;
    armInactivityTimer();
  }

  function armInactivityTimer() {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      logger.warn(
        { bay: bayNumber, sessionId: currentSession?.id, threshold: inactivityMs },
        'inactivity timeout — closing session as safety net'
      );
      closeSession('inactivity_timeout').catch((err) =>
        logger.error({ err: err.message }, 'inactivity close failed')
      );
    }, inactivityMs);
  }

  function clearInactivityTimer() {
    if (inactivityTimer) {
      clearTimeout(inactivityTimer);
      inactivityTimer = null;
    }
  }

  async function openSession(booking) {
    let player;
    try {
      player = await supabase.upsertPlayer({
        optix_user_id:   booking.user_id,
        optix_member_id: booking.account_id,
        email:           booking.email,
        display_name:    booking.fullname
      });
    } catch (err) {
      logger.error(
        { err: err.message, bookingId: booking.booking_id, userId: booking.user_id },
        'player upsert failed — will retry on next poll'
      );
      return false;
    }

    // Resume if a session for this booking is already open (e.g. relay restart)
    let session;
    try {
      const existing = await supabase.findOpenSessionByBooking({
        optixBookingId: booking.booking_id,
        bayNumber
      });
      if (existing) {
        session = existing;
        logger.info(
          { sessionId: session.id, bookingId: booking.booking_id, bay: bayNumber },
          'resuming existing open session for booking'
        );
      } else {
        session = await supabase.createSession({
          player_id:        player.id,
          bay_number:       bayNumber,
          optix_booking_id: booking.booking_id,
          started_at:       new Date().toISOString()
        });
        logger.info(
          { sessionId: session.id, bookingId: booking.booking_id, bay: bayNumber, playerId: player.id },
          'session opened'
        );
      }
    } catch (err) {
      logger.error(
        { err: err.message, bookingId: booking.booking_id },
        'session create/find failed — will retry on next poll'
      );
      return false;
    }

    currentSession = {
      id: session.id,
      player_id: player.id,
      optix_booking_id: booking.booking_id
    };
    state = STATE.SESSION_OPEN;
    armInactivityTimer();

    // Best-effort backfill of recently-recorded NULL shots.
    if (backfillMs > 0) {
      const sinceIso = new Date(Date.now() - backfillMs).toISOString();
      const beforeIso = new Date().toISOString();
      try {
        const updated = await supabase.backfillNullShots({
          bayNumber,
          sessionId: session.id,
          playerId: player.id,
          sinceIso,
          beforeIso
        });
        if (updated > 0) {
          logger.info({ sessionId: session.id, count: updated, windowMs: backfillMs }, 'backfilled pre-session shots');
        }
      } catch (err) {
        logger.error({ err: err.message }, 'backfill failed (non-fatal)');
      }
    }

    return true;
  }

  async function closeSession(reason) {
    if (!currentSession) {
      state = STATE.NO_SESSION;
      return;
    }
    const { id } = currentSession;
    clearInactivityTimer();
    let count = 0;
    try {
      count = await supabase.countShotsForSession(id);
    } catch (err) {
      logger.error({ err: err.message, sessionId: id }, 'shot count query failed — closing with count=0');
    }
    try {
      await supabase.closeSession({
        session_id: id,
        ended_at:   new Date().toISOString(),
        shot_count: count
      });
      logger.info({ sessionId: id, reason, shotCount: count }, 'session closed');
    } catch (err) {
      logger.error({ err: err.message, sessionId: id }, 'session close patch failed — local state cleared anyway');
    }
    currentSession = null;
    state = STATE.NO_SESSION;
  }

  async function _runPollOnce() {
    if (stopped) return;
    if (pollInFlight) {
      logger.debug('previous poll still in flight, skipping');
      return;
    }
    pollInFlight = true;
    try {
      const booking = await optixClient.getCurrentBooking(resourceId);

      if (!booking) {
        if (state === STATE.SESSION_OPEN) {
          logger.info({ bay: bayNumber, sessionId: currentSession?.id }, 'poll found no active booking — closing session');
          await closeSession('booking_ended');
        }
        return;
      }

      // Booking present.
      if (state === STATE.NO_SESSION) {
        await openSession(booking);
        return;
      }

      // SESSION_OPEN.
      if (currentSession?.optix_booking_id !== booking.booking_id) {
        logger.warn(
          {
            bay: bayNumber,
            current: currentSession?.optix_booking_id,
            incoming: booking.booking_id
          },
          'poll returned different booking_id while session open — rotating session'
        );
        await closeSession('booking_rotated');
        await openSession(booking);
      }
      // Otherwise same booking, no-op.
    } catch (err) {
      logger.error({ err: err.message, bay: bayNumber }, 'optix poll failed — keeping current state');
    } finally {
      pollInFlight = false;
      if (_pollResolver) {
        const r = _pollResolver;
        _pollResolver = null;
        r();
      }
    }
  }

  function schedulePoll() {
    if (stopped) return;
    pollTimer = setTimeout(async () => {
      await _runPollOnce();
      schedulePoll();
    }, pollIntervalMs);
  }

  async function start() {
    if (!enabled) {
      logger.info(
        {
          optixEnabled: optixClient?.enabled,
          supabaseEnabled: supabase?.enabled,
          resourceId
        },
        'session manager disabled — shots will save with NULL session/player'
      );
      return;
    }
    logger.info(
      { bay: bayNumber, resourceId, pollIntervalMs, inactivityMs, backfillMs },
      'session manager starting'
    );
    // Run an immediate poll, then schedule recurring polls.
    await _runPollOnce();
    schedulePoll();
  }

  async function stop() {
    stopped = true;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    clearInactivityTimer();
    if (state === STATE.SESSION_OPEN) {
      await closeSession('shutdown');
    }
    state = STATE.STOPPED;
  }

  // Test helper: returns a promise that resolves after the next poll completes.
  function _nextPollComplete() {
    return new Promise((resolve) => { _pollResolver = resolve; });
  }

  return {
    start,
    stop,
    getCurrentTag,
    noteShot,
    enabled,
    // Internals exposed for tests
    _runPollOnce,
    _nextPollComplete,
    _state: () => state,
    _currentSession: () => currentSession
  };
}

module.exports = { createSessionManager, STATE };
