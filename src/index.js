'use strict';

const path = require('path');
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { createSupabaseClient } = require('./supabase');
const { createOptixClient } = require('./optix-client');
const { createSessionManager } = require('./session-manager');
const { createPersistence } = require('./persistence');
const { createFileWatcher } = require('./file-watcher');
const { createLastShotTracker } = require('./last-shot');

async function main() {
  const configPath = process.env.RELAY_CONFIG || path.resolve(__dirname, '..', 'config.json');
  const config = loadConfig(configPath);
  const logger = createLogger(config);

  logger.info(
    {
      bay: config.bay.number,
      watchRoot: config.watch.shotDataDir,
      supabase: config.supabase.serviceKey ? 'enabled' : 'disabled',
      optix: config.optix?.orgToken ? 'enabled' : 'disabled',
      configPath
    },
    'starting clubhouse-relay'
  );

  const dataDir = path.resolve(__dirname, '..', 'data');
  const lastShot = createLastShotTracker({ dataDir, logger });

  const supabase = createSupabaseClient({ config, logger });
  const optixClient = createOptixClient({ config, logger });
  const sessionManager = createSessionManager({ config, logger, optixClient, supabase });

  const persistence = createPersistence({
    config,
    logger,
    supabase,
    getTag: () => sessionManager.getCurrentTag()
  });

  const watcher = createFileWatcher({
    config,
    logger,
    lastShot,
    onShot: (shot) => {
      try {
        persistence.saveShot(shot);
      } catch (err) {
        logger.error({ err: err.message }, 'persistence.saveShot threw');
      }
      try {
        sessionManager.noteShot();
      } catch (err) {
        logger.error({ err: err.message }, 'sessionManager.noteShot threw');
      }
    }
  });

  await watcher.start();

  // Non-blocking Supabase reachability check.
  supabase.healthCheck().then((result) => {
    if (result.skipped) return;
    if (result.ok) logger.info({ status: result.status }, 'supabase health check passed');
    else logger.error(result, 'supabase health check FAILED — shots will still land in shots.jsonl');
  }).catch((err) => {
    logger.error({ err: err.message }, 'supabase health check threw');
  });

  // Start the Optix poll loop. start() runs an immediate poll and schedules
  // the recurring loop. We don't await it — a slow first poll must not delay
  // the watcher.
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
      await watcher.stop();
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
