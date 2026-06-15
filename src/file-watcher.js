'use strict';

// Watches Uneekor VIEW's ShotData directory and dispatches one parsed shot
// per per-shot subdir. Fires when ProShotInfo.json closes — it's the last
// file in the burst (shotinfo.json + the JPG batch land ~9 s earlier when
// VIEW captures the swing). Triggering on the earlier files would race the
// writer and produce torn reads.
//
// Persistent last-seen <n> ensures restarts don't re-ingest stale dirs.

const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const { readShotDir } = require('./view-parser');

const TRIGGER_FILE = 'ProShotInfo.json';

function createFileWatcher({ config, logger, lastShot, onShot }) {
  const watchRoot = config.watch.shotDataDir;
  const stabilityMs = config.watch?.writeStabilityMs ?? 500;
  const pollMs = config.watch?.pollIntervalMs ?? 100;

  let watcher = null;
  let stopped = false;
  // Tracks file paths we've already processed within this process run. Belt-and-
  // suspenders alongside lastShot: chokidar can emit `add` and `change` for the
  // same file when awaitWriteFinish bookends a slow writer.
  const processedInRun = new Set();

  function processFile(filePath) {
    if (stopped) return;
    if (path.basename(filePath) !== TRIGGER_FILE) return;
    if (processedInRun.has(filePath)) return;

    const dir = path.dirname(filePath);
    const dirName = path.basename(dir);
    const n = parseInt(dirName, 10);
    if (!Number.isInteger(n) || n <= 0 || String(n) !== dirName) {
      logger.debug({ filePath, dirName }, 'non-numeric shot dir, skipping');
      return;
    }

    const lastSeen = lastShot.read();
    if (n <= lastSeen) {
      processedInRun.add(filePath);
      return;
    }

    const result = readShotDir({ dir, shotNumber: n });
    if (!result.ok) {
      if (result.filtered) {
        logger.info({ n, reason: result.reason }, 'shot filtered (reference/demo)');
        // Still advance last-seen so we don't re-evaluate the demo dir.
        lastShot.write(n);
        processedInRun.add(filePath);
      } else {
        logger.warn(
          { n, reason: result.reason, error: result.error },
          'failed to read shot dir — will retry on next event'
        );
        // Don't advance last-seen; chokidar may re-emit when the writer finishes.
      }
      return;
    }

    logger.info(
      {
        n,
        ballSpeed: result.value.ballSpeed,
        clubName: result.value.clubName,
        playerName: result.value.playerName
      },
      'shot captured from VIEW'
    );

    try {
      onShot(result.value);
    } catch (err) {
      logger.error({ err: err.message, n }, 'onShot callback threw');
    }

    lastShot.write(n);
    processedInRun.add(filePath);
  }

  async function start() {
    if (!fs.existsSync(watchRoot)) {
      logger.warn(
        { watchRoot },
        'watch dir does not exist yet; creating so chokidar can attach'
      );
      try { fs.mkdirSync(watchRoot, { recursive: true }); }
      catch (err) { logger.error({ err: err.message, watchRoot }, 'failed to create watch dir'); }
    }

    logger.info(
      { watchRoot, lastSeen: lastShot.read(), stabilityMs },
      'starting VIEW file watcher'
    );

    // chokidar v4 removed glob support, so we watch the root and let the
    // basename check in processFile() do the filtering. ShotData/<n>/<file>
    // is depth 2 from the root.
    watcher = chokidar.watch(watchRoot, {
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: stabilityMs,
        pollInterval: pollMs
      },
      depth: 2,
      ignored: (filePath, stats) => {
        if (!stats) return false;          // can't decide without stats — let it through
        if (stats.isDirectory()) return false;
        return path.basename(filePath) !== TRIGGER_FILE;
      }
    });

    watcher.on('add', processFile);
    watcher.on('change', processFile);
    watcher.on('error', (err) => logger.error({ err: err.message }, 'chokidar error'));

    await new Promise((resolve) => {
      watcher.on('ready', resolve);
    });
    logger.info('file watcher ready');
  }

  async function stop() {
    stopped = true;
    if (watcher) {
      await watcher.close();
      watcher = null;
    }
  }

  return {
    start,
    stop,
    // Exposed for tests — drive a process cycle with a synthetic path.
    _processFile: processFile
  };
}

module.exports = { createFileWatcher, TRIGGER_FILE };
