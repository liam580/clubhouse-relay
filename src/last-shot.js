'use strict';

// Persistent "highest shot <n> we've ingested" tracker.
//
// VIEW's per-shot directory counter is lifetime (currently up to 993), not
// per-session. Across relay restarts we must not re-ingest old shots that
// happen to still be on disk. We persist the last-seen <n> next to the JSONL
// in `data/last-shot.json`. Reads default to 0 on missing/corrupt file —
// worst case is one round of re-processing on first install.

const fs = require('fs');
const path = require('path');

function createLastShotTracker({ dataDir, logger }) {
  const filePath = path.join(dataDir, 'last-shot.json');

  function read() {
    try {
      if (!fs.existsSync(filePath)) return 0;
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return Number.isInteger(parsed.n) && parsed.n >= 0 ? parsed.n : 0;
    } catch (err) {
      if (logger) logger.warn({ err: err.message, filePath }, 'last-shot file unreadable, resetting to 0');
      return 0;
    }
  }

  function write(n) {
    if (!Number.isInteger(n) || n < 0) return;
    const current = read();
    if (n <= current) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        JSON.stringify({ n, updated_at: new Date().toISOString() }, null, 2) + '\n'
      );
    } catch (err) {
      if (logger) logger.error({ err: err.message, filePath, n }, 'failed to persist last-shot');
    }
  }

  return { read, write, filePath };
}

module.exports = { createLastShotTracker };
