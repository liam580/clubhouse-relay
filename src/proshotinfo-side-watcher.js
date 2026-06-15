'use strict';

// Side-watcher on VIEW's ShotData directory. Sole job: maintain an
// in-memory cache of the most recent ProShotInfo.json content so the
// Connect-log shot pipeline can attach player + club context. The Connect
// envelope itself has no player identity.
//
// Behaviour:
//   - On startup: scan the watch dir for the highest-numbered existing
//     ProShotInfo.json and pre-cache it so a relay restart mid-session
//     immediately has player context (no warm-up gap until next shot).
//   - At runtime: chokidar watches for new/changed ProShotInfo.json under
//     any numbered subdir, refreshes the cache, ignores Star: true demos.
//   - Cache expires after staleMs of inactivity — rapid-fire hitting
//     across two players in <staleMs would attribute the second to the
//     first, but that's an acceptable boundary case for our facility.

const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

const TRIGGER_FILE = 'ProShotInfo.json';
const DEFAULT_STALE_MS = 30000;

function listShotDirsDescending(root) {
  if (!fs.existsSync(root)) return [];
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, n: parseInt(e.name, 10) }))
      .filter(({ name, n }) => Number.isInteger(n) && n > 0 && String(n) === name)
      .sort((a, b) => b.n - a.n)
      .map(({ n }) => n);
  } catch {
    return [];
  }
}

function createProShotInfoSideWatcher({ config, logger, staleMs = DEFAULT_STALE_MS }) {
  const watchRoot = config.watch.shotDataDir;
  let cached = null;
  let cachedAt = 0;
  let watcher = null;
  let stopped = false;

  function readAndCache(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(content);
      if (parsed && parsed.Star === true) {
        logger.debug({ filePath }, 'side-watcher: skipping Star:true demo shot');
        return;
      }
      cached = parsed;
      cachedAt = Date.now();
      logger.debug(
        { Name: parsed.Name, Club: parsed.Club, ClubName: parsed.ClubName },
        'side-watcher cached ProShotInfo'
      );
    } catch (err) {
      logger.warn({ filePath, err: err.message }, 'side-watcher: failed to read ProShotInfo.json');
    }
  }

  function handleEvent(filePath) {
    if (stopped) return;
    if (path.basename(filePath) !== TRIGGER_FILE) return;
    readAndCache(filePath);
  }

  async function start() {
    if (!fs.existsSync(watchRoot)) {
      logger.warn(
        { watchRoot },
        'side-watcher: watch dir does not exist yet, creating so chokidar can attach'
      );
      try { fs.mkdirSync(watchRoot, { recursive: true }); }
      catch (err) { logger.error({ err: err.message, watchRoot }, 'side-watcher: failed to create watch dir'); }
    }

    // Pre-cache from the most recent existing ProShotInfo. If the relay
    // restarts mid-session, the first Connect shot after restart gets
    // attributed correctly without waiting for VIEW to write another shot.
    const recent = listShotDirsDescending(watchRoot).slice(0, 5);
    for (const n of recent) {
      const candidate = path.join(watchRoot, String(n), TRIGGER_FILE);
      if (fs.existsSync(candidate)) {
        readAndCache(candidate);
        if (cached) break;
      }
    }

    watcher = chokidar.watch(watchRoot, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 80 },
      depth: 2,
      ignored: (filePath, stats) => {
        if (!stats) return false;
        if (stats.isDirectory()) return false;
        return path.basename(filePath) !== TRIGGER_FILE;
      },
    });

    watcher.on('add', handleEvent);
    watcher.on('change', handleEvent);
    watcher.on('error', (err) => logger.error({ err: err.message }, 'side-watcher chokidar error'));

    await new Promise((resolve) => watcher.on('ready', resolve));
    logger.info(
      { watchRoot, preCached: cached != null, preCachedName: cached?.Name },
      'ProShotInfo side-watcher ready'
    );
  }

  async function stop() {
    stopped = true;
    if (watcher) { await watcher.close(); watcher = null; }
  }

  // Returns the cached ProShotInfo content, or null if not present / stale.
  function get() {
    if (cached == null) return null;
    if (Date.now() - cachedAt > staleMs) return null;
    return cached;
  }

  return {
    start,
    stop,
    get,
    // Test seam — let smoke set the cache directly.
    _setCacheForTesting: (data) => { cached = data; cachedAt = Date.now(); },
    _cacheState: () => ({ data: cached, ageMs: cached ? Date.now() - cachedAt : null }),
  };
}

module.exports = { createProShotInfoSideWatcher };
