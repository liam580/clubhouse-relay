const fs = require('fs');
const path = require('path');

function loadConfig(configPath) {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Config file not found: ${resolved}\n` +
        `Copy config.example.json to config.json and fill in bay number + watch.shotDataDir.`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse ${resolved}: ${err.message}`);
  }

  validateConfig(parsed);
  return parsed;
}

function validateConfig(c) {
  const errors = [];
  const req = (cond, msg) => { if (!cond) errors.push(msg); };

  req(c.bay && Number.isInteger(c.bay.number), 'bay.number must be an integer');
  req(c.bay && typeof c.bay.optixResourceId === 'string', 'bay.optixResourceId must be a string');

  req(
    c.watch && typeof c.watch.shotDataDir === 'string' && c.watch.shotDataDir.length > 0,
    'watch.shotDataDir must be a non-empty string (path to VIEW ShotData directory)'
  );
  if (c.watch && c.watch.writeStabilityMs !== undefined) {
    req(
      Number.isInteger(c.watch.writeStabilityMs) && c.watch.writeStabilityMs >= 0,
      'watch.writeStabilityMs must be a non-negative integer'
    );
  }
  if (c.watch && c.watch.pollIntervalMs !== undefined) {
    req(
      Number.isInteger(c.watch.pollIntervalMs) && c.watch.pollIntervalMs >= 10,
      'watch.pollIntervalMs must be an integer >= 10'
    );
  }

  req(c.supabase && typeof c.supabase.url === 'string', 'supabase.url must be a string (may be empty)');
  req(c.supabase && typeof c.supabase.serviceKey === 'string', 'supabase.serviceKey must be a string (may be empty)');
  req(c.supabase && typeof c.supabase.shotsTable === 'string', 'supabase.shotsTable must be a string');

  if (c.optix !== undefined) {
    req(typeof c.optix.graphqlUrl === 'string' && c.optix.graphqlUrl.length > 0, 'optix.graphqlUrl required when optix block present');
    req(typeof c.optix.orgToken === 'string', 'optix.orgToken must be a string (may be empty to disable session polling)');
    req(Number.isInteger(c.optix.pollIntervalMs) && c.optix.pollIntervalMs >= 1000, 'optix.pollIntervalMs must be >= 1000');
    req(Number.isInteger(c.optix.fetchTimeoutMs) && c.optix.fetchTimeoutMs >= 1000, 'optix.fetchTimeoutMs must be >= 1000');
  }
  if (c.session !== undefined) {
    if (c.session.backfillWindowMs !== undefined) {
      req(Number.isInteger(c.session.backfillWindowMs) && c.session.backfillWindowMs >= 0, 'session.backfillWindowMs must be a non-negative integer');
    }
  }

  if (errors.length) {
    throw new Error('Invalid config:\n  - ' + errors.join('\n  - '));
  }
}

module.exports = { loadConfig, validateConfig };
