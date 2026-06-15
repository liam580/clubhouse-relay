'use strict';

// GSPconnect's debug log fans out per shot into 4 lines: DEBUG+INFO with
// the ball half, then DEBUG+INFO with the club half ~300–450ms later.
// Same ShotNumber across all four. The reassembler merges them into one
// envelope and emits exactly once per shot.
//
// Edge cases handled:
//   - Both halves arrive → emit immediately, drop from pending
//   - DEBUG+INFO duplicate for the same half → first one wins, second is
//     idempotent
//   - Only one half within timeoutMs → emit what we have (ball half alone
//     covers carry + ball speed + spin; club half alone is rare and less
//     useful but we emit anyway rather than drop)
//   - IsHeartBeat: true → skipped without entering the pending map
//   - Defensive: if ShotDataOptions.ContainsBallData/ContainsClubData
//     aren't set (older Connect versions), fall back to the presence of
//     BallData / ClubData subobjects

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_SWEEP_INTERVAL_MS = 1000;

// How long to remember already-emitted ShotNumbers so the DEBUG+INFO
// duplicates that arrive AFTER the first complete pair don't re-enter
// pending and get falsely swept as a partial. 10s comfortably covers the
// ~300-450ms ball→club gap plus the DEBUG/INFO log latency.
const DEFAULT_EMITTED_TTL_MS = 10000;

function createReassembler({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
  emittedTtlMs = DEFAULT_EMITTED_TTL_MS,
  onShot,
  logger,
} = {}) {
  const pending = new Map();          // ShotNumber → { ball, club, firstSeenAt }
  const emittedRecently = new Map();  // ShotNumber → emittedAt timestamp
  let sweeper = null;
  let stopped = false;
  let emitted = 0;
  let partials = 0;

  function emit(n, entry) {
    pending.delete(n);
    emittedRecently.set(n, Date.now());
    const ball = entry.ball;
    const club = entry.club;
    const merged = {
      // Take the top-level envelope fields from whichever half arrived first.
      ...(ball || club),
      BallData:         ball ? ball.BallData : null,
      ClubData:         club ? club.ClubData : null,
      ShotDataOptions:  (ball && ball.ShotDataOptions) || (club && club.ShotDataOptions) || null,
    };
    emitted++;
    if (!ball || !club) partials++;
    if (logger) {
      logger.debug(
        { ShotNumber: n, hasBall: !!ball, hasClub: !!club, partial: !ball || !club },
        'reassembler emit'
      );
    }
    try { onShot && onShot(merged); }
    catch (err) {
      if (logger) logger.error({ err: err.message, ShotNumber: n }, 'onShot callback threw');
    }
  }

  function feed(env) {
    if (stopped) return;
    if (env == null || env.ShotNumber == null) return;
    const opts = env.ShotDataOptions || {};
    if (opts.IsHeartBeat === true) return;

    const n = env.ShotNumber;

    // Already emitted? Ignore the trailing DEBUG/INFO duplicate. Without
    // this, a post-emit duplicate would re-create a pending entry that
    // never gets a matching opposite-half and would emit as a phantom
    // partial after the sweep timeout.
    if (emittedRecently.has(n)) return;

    const containsBall = opts.ContainsBallData === true || env.BallData != null;
    const containsClub = opts.ContainsClubData === true || env.ClubData != null;

    // Connect emits status pings (LaunchMonitorBallDetected, LaunchMonitorIsReady,
    // etc.) with IsHeartBeat: false but neither Contains*Data flag set and no
    // BallData/ClubData subobject. Don't enter pending for those — otherwise
    // the sweep would later emit an all-null phantom row.
    if (!containsBall && !containsClub) return;

    const entry = pending.get(n) || { ball: null, club: null, firstSeenAt: Date.now() };

    if (containsBall && entry.ball == null) entry.ball = env;
    if (containsClub && entry.club == null) entry.club = env;

    if (entry.ball && entry.club) {
      emit(n, entry);
      return;
    }

    pending.set(n, entry);
  }

  function sweep() {
    if (stopped) return;
    const now = Date.now();
    for (const [n, entry] of pending) {
      if (now - entry.firstSeenAt > timeoutMs) {
        // Better a partial than a dropped shot — ball half alone still
        // has carry + ball speed + spin, which is what the canvas needs.
        emit(n, entry);
      }
    }
    // Age out the emittedRecently set so it doesn't grow unbounded.
    for (const [n, t] of emittedRecently) {
      if (now - t > emittedTtlMs) emittedRecently.delete(n);
    }
  }

  function start() {
    if (sweeper) return;
    sweeper = setInterval(sweep, sweepIntervalMs);
    if (sweeper.unref) sweeper.unref();
  }

  function stop() {
    stopped = true;
    if (sweeper) { clearInterval(sweeper); sweeper = null; }
    pending.clear();
  }

  function stats() {
    return { emitted, partials, pending: pending.size };
  }

  return { feed, start, stop, sweep, stats, _pending: () => pending };
}

module.exports = { createReassembler };
