'use strict';

// Tail a log file that mirrors the GSPro Open Connect envelope stream and
// emit each parsed envelope to the reassembler.
//
// Two known sources produce that envelope on this stack, both selectable
// via config.connect.logPath:
//
//   1. Uneekor VIEW's `Player.log` (the current canonical source).
//      `%USERPROFILE%\AppData\LocalLow\Uneekor\VIEW\Player.log`
//      VIEW logs each outbound envelope with an "====>" prefix and
//      packs BallData + ClubData into ONE line.
//
//   2. GSPconnect's `ConnectDebug.txt` (the original 2026-06-15 source,
//      no longer in the data path on bays where VIEW talks to GS Pro
//      directly — see docs/session-findings-2026-06-18.md).
//      Connect logs envelopes with a `- {"DeviceID` log4net prefix and
//      fans the shot out across 4 DEBUG+INFO lines (ball half + club
//      half), which the reassembler stitches back together.
//
// MARKER is the substring that identifies either format — `{"DeviceID"`
// is the JSON envelope opener common to both. extractEnvelope scans
// forward from MARKER for the first `{` and JSON.parses from there, so
// it's tolerant to any prefix shape (log4net, "====>", future formats).
//
// Rotation: VIEW's Player.log rolls only when VIEW restarts (rare in
// practice — multiple days between rotations). GSPconnect rotates on
// 10 MB. `tail`'s useWatchFile + follow handles either rate.

const fs = require('fs');
const { Tail } = require('tail');

const MARKER = '{"DeviceID"';
const HEARTBEAT_MS = 5 * 60 * 1000;
const REATTACH_INITIAL_MS = 5 * 1000;
const REATTACH_MAX_MS = 60 * 1000;

function extractEnvelope(line) {
  if (line == null) return null;
  const i = line.indexOf(MARKER);
  if (i < 0) return null;
  const jsonStart = line.indexOf('{', i);
  if (jsonStart < 0) return null;
  const candidate = line.slice(jsonStart);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function createConnectLogTail({ config, logger, onEnvelope }) {
  const logPath = config.connect.logPath;
  const fromBeginning = Boolean(config.connect.fromBeginning);
  let tail = null;
  let stopped = false;
  let linesSeen = 0;
  let envelopesEmitted = 0;
  let lastEnvelopeAt = null;
  let heartbeat = null;
  let reattachTimer = null;
  let reattachBackoffMs = REATTACH_INITIAL_MS;
  let reattachCount = 0;
  let lastReattachAt = null;

  // Build a fresh Tail and wire its listeners. Returns true on success,
  // false on failure (caller schedules retry).
  function attach() {
    if (stopped) return false;
    if (!fs.existsSync(logPath)) {
      logger.warn({ logPath }, 'log file does not exist yet — will retry');
      return false;
    }
    try {
      tail = new Tail(logPath, {
        follow: true,
        flushAtEOF: true,
        fromBeginning,
        useWatchFile: true,           // more reliable across log rotation on Windows
        fsWatchOptions: { interval: 100 },
        logger: { info: () => {}, error: (msg) => logger.error({ tail: String(msg) }, 'tail logger error') },
      });
    } catch (err) {
      logger.error({ err: err.message, logPath }, 'failed to create Tail');
      return false;
    }

    tail.on('line', (line) => {
      if (stopped) return;
      linesSeen++;
      const env = extractEnvelope(line);
      if (env == null) return;
      const wasFirst = envelopesEmitted === 0;
      envelopesEmitted++;
      lastEnvelopeAt = Date.now();
      if (wasFirst) {
        logger.info({ ShotNumber: env.ShotNumber, linesSeen }, 'first envelope detected after start');
      }
      try {
        onEnvelope(env);
      } catch (err) {
        logger.error({ err: err.message, ShotNumber: env.ShotNumber }, 'onEnvelope callback threw');
      }
    });

    tail.on('error', (err) => {
      logger.error({ err: err.message || String(err), reattachBackoffMs }, 'tail error — scheduling re-attach');
      scheduleReattach();
    });

    return true;
  }

  // Re-attach after a delay with exponential backoff. Idempotent — if a
  // re-attach is already scheduled, this is a no-op. Backoff caps at
  // REATTACH_MAX_MS and resets to REATTACH_INITIAL_MS after a successful
  // attach that survives long enough to see a line.
  function scheduleReattach() {
    if (stopped || reattachTimer) return;
    if (tail) {
      try { tail.unwatch(); } catch { /* swallow */ }
      tail = null;
    }
    reattachTimer = setTimeout(() => {
      reattachTimer = null;
      if (stopped) return;
      reattachCount++;
      lastReattachAt = Date.now();
      logger.info({ logPath, reattachCount, backoffMs: reattachBackoffMs }, 're-attaching shot log tail');
      const ok = attach();
      if (ok) {
        logger.info({ logPath }, 'shot log tail re-attached');
        // Don't reset the backoff yet — wait for a line to confirm the
        // attach is healthy. Reset happens in the line handler below
        // via the first successful read after a re-attach.
        const lineCountAtAttach = linesSeen;
        setTimeout(() => {
          if (!stopped && linesSeen > lineCountAtAttach) {
            reattachBackoffMs = REATTACH_INITIAL_MS;
          }
        }, 30 * 1000);
      } else {
        reattachBackoffMs = Math.min(reattachBackoffMs * 2, REATTACH_MAX_MS);
        scheduleReattach();
      }
    }, reattachBackoffMs);
    if (reattachTimer.unref) reattachTimer.unref();
  }

  async function start() {
    if (!fs.existsSync(logPath)) {
      logger.warn({ logPath }, 'log file does not exist yet — tail will wait for the file');
    }

    logger.info({ logPath, fromBeginning }, 'starting shot log tail');

    const ok = attach();
    if (!ok) {
      // File missing or constructor threw — let the re-attach loop handle it.
      logger.warn({ logPath }, 'initial attach failed — entering re-attach loop');
      scheduleReattach();
    }

    heartbeat = setInterval(() => {
      logger.info(
        {
          linesSeen,
          envelopesEmitted,
          msSinceLastEnvelope: lastEnvelopeAt ? Date.now() - lastEnvelopeAt : null,
          attached: tail != null,
          reattachCount,
          lastReattachAt,
        },
        'shot log tail heartbeat'
      );
    }, HEARTBEAT_MS);
    if (heartbeat.unref) heartbeat.unref();

    logger.info('shot log tail attached');
  }

  function stop() {
    stopped = true;
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    if (reattachTimer) { clearTimeout(reattachTimer); reattachTimer = null; }
    if (tail) {
      try { tail.unwatch(); } catch { /* swallow */ }
      tail = null;
    }
  }

  function stats() {
    return {
      linesSeen,
      envelopesEmitted,
      lastEnvelopeAt,
      msSinceLastEnvelope: lastEnvelopeAt ? Date.now() - lastEnvelopeAt : null,
      attached: tail != null,
      reattachCount,
      lastReattachAt,
    };
  }

  return { start, stop, stats };
}

module.exports = { createConnectLogTail, extractEnvelope, MARKER };
