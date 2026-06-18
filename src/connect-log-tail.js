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

  async function start() {
    if (!fs.existsSync(logPath)) {
      logger.warn({ logPath }, 'Connect log does not exist yet — tail will wait for the file');
    }

    logger.info({ logPath, fromBeginning }, 'starting shot log tail');

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
      throw err;
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
      logger.error({ err: err.message || String(err) }, 'tail error');
    });

    heartbeat = setInterval(() => {
      logger.info(
        {
          linesSeen,
          envelopesEmitted,
          msSinceLastEnvelope: lastEnvelopeAt ? Date.now() - lastEnvelopeAt : null,
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
    };
  }

  return { start, stop, stats };
}

module.exports = { createConnectLogTail, extractEnvelope, MARKER };
