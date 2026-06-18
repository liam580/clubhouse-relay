'use strict';

// Tail GSPconnect's ConnectDebug.txt (default
// C:\GSProV1\Core\GSPC\ConnectDebug.txt) and emit each parsed Open Connect
// envelope to the reassembler. The log is the canonical egress for the
// post-translation GS Pro envelope — mph, yards, carry already computed.
//
// Filter strategy: any line whose suffix starts with `- {"DeviceID` is a
// shot/heartbeat envelope. Vendor-agnostic — works across the Uneekor,
// FullSwing, FlightScope, etc. logger names. JSON.parse extracts the
// envelope; we hand it to the reassembler unchanged.
//
// Rotation: log4net renames the active file when it crosses 10 MB. The
// `tail` package's useWatchFile + follow handles rotation by polling the
// stat — we lose the in-flight line but pick up immediately on the new
// file.

const fs = require('fs');
const { Tail } = require('tail');

const MARKER = '- {"DeviceID';
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

    logger.info({ logPath, fromBeginning }, 'starting Connect log tail');

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
        'Connect log tail heartbeat'
      );
    }, HEARTBEAT_MS);
    if (heartbeat.unref) heartbeat.unref();

    logger.info('Connect log tail attached');
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
