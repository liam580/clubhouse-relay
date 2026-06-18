'use strict';

const path = require('path');
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { createSupabaseClient } = require('./supabase');
const { createOptixClient } = require('./optix-client');
const { createSessionManager } = require('./session-manager');
const { createPersistence } = require('./persistence');
const { createConnectLogTail } = require('./connect-log-tail');
const { createReassembler } = require('./reassembler');
const { createProShotInfoSideWatcher } = require('./proshotinfo-side-watcher');
const { envelopeToShot } = require('./gspro-parser');

async function main() {
  const configPath = process.env.RELAY_CONFIG || path.resolve(__dirname, '..', 'config.json');
  const config = loadConfig(configPath);
  const logger = createLogger(config);

  logger.info(
    {
      bay:        config.bay.number,
      shotLog:    config.connect.logPath,
      watchRoot:  config.watch.shotDataDir,
      supabase:   config.supabase.serviceKey ? 'enabled' : 'disabled',
      optix:      config.optix?.orgToken ? 'enabled' : 'disabled',
      configPath,
    },
    'starting clubhouse-relay'
  );

  const supabase = createSupabaseClient({ config, logger });
  const optixClient = createOptixClient({ config, logger });
  const sessionManager = createSessionManager({ config, logger, optixClient, supabase });

  const persistence = createPersistence({
    config,
    logger,
    supabase,
    getTag: () => sessionManager.getCurrentTag(),
  });

  // Side-watcher: maintains an in-memory cache of the most recent
  // ProShotInfo.json so each Connect-sourced shot can be attributed to a
  // player/club. The Connect envelope has no player identity.
  const sideWatcher = createProShotInfoSideWatcher({ config, logger });

  // Reassembler: merges the 4 log lines per shot (ball+club halves, each
  // emitted at DEBUG+INFO) into a single envelope, then hands off.
  const reassembler = createReassembler({
    timeoutMs: 3000,
    sweepIntervalMs: 1000,
    logger,
    onShot: (mergedEnv) => {
      const shot = envelopeToShot(mergedEnv, sideWatcher.get());
      try {
        persistence.saveShot(shot);
      } catch (err) {
        logger.error({ err: err.message, ShotNumber: shot.shotNumber }, 'persistence.saveShot threw');
      }
      try {
        sessionManager.noteShot();
      } catch (err) {
        logger.error({ err: err.message }, 'sessionManager.noteShot threw');
      }
    },
  });

  // Shot log tail: reads either VIEW's Player.log (current canonical source,
  // ====> envelopes) or GSPconnect's ConnectDebug.txt (legacy, '- {' log4net
  // prefix), extracts envelopes, feeds the reassembler. Both sources speak
  // GS Pro Open Connect — mph, yards, carry already computed.
  const logTail = createConnectLogTail({
    config,
    logger,
    onEnvelope: (env) => reassembler.feed(env),
  });

  await sideWatcher.start();
  reassembler.start();
  await logTail.start();

  // Non-blocking Supabase reachability check.
  supabase.healthCheck().then((result) => {
    if (result.skipped) return;
    if (result.ok) logger.info({ status: result.status }, 'supabase health check passed');
    else logger.error(result, 'supabase health check FAILED — shots will still land in shots.jsonl');
  }).catch((err) => {
    logger.error({ err: err.message }, 'supabase health check threw');
  });

  // Start the Optix poll loop.
  sessionManager.start().catch((err) => {
    logger.error({ err: err.message }, 'session manager start failed');
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    try {
      await sessionManager.stop();
      logTail.stop();
      reassembler.stop();
      await sideWatcher.stop();
      await persistence.close();
    } catch (err) {
      logger.error({ err: err.message }, 'error during shutdown');
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    logger.fatal({ err: err.message, stack: err.stack }, 'uncaughtException');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: String(reason) }, 'unhandledRejection');
  });
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
