const fs = require('fs');
const path = require('path');

function loadConfig(configPath) {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Config file not found: ${resolved}\n` +
        `Copy config.example.json to config.json and fill in bay number + ports.`
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

  req(c.relay && typeof c.relay.listenHost === 'string', 'relay.listenHost must be a string');
  req(c.relay && Number.isInteger(c.relay.listenPort), 'relay.listenPort must be an integer');

  req(c.gspro && typeof c.gspro.host === 'string', 'gspro.host must be a string');
  req(c.gspro && Number.isInteger(c.gspro.port), 'gspro.port must be an integer');

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

  if (
    c.relay && c.gspro &&
    c.relay.listenPort === c.gspro.port &&
    (c.gspro.host === '127.0.0.1' || c.gspro.host === 'localhost' || c.relay.listenHost === '127.0.0.1' || c.relay.listenHost === '0.0.0.0')
  ) {
    errors.push(
      `relay.listenPort (${c.relay.listenPort}) and gspro.port (${c.gspro.port}) collide on the same host — the relay would loop into itself.`
    );
  }

  if (errors.length) {
    throw new Error('Invalid config:\n  - ' + errors.join('\n  - '));
  }
}

module.exports = { loadConfig, validateConfig };
