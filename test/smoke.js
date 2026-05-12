'use strict';

const net = require('net');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { createLogger } = require('../src/logger');
const { createPersistence } = require('../src/persistence');
const { createRelay } = require('../src/relay');
const { JSONFramer } = require('../src/parser');
const { createSupabaseClient } = require('../src/supabase');
const { createOptixClient } = require('../src/optix-client');
const { createSessionManager } = require('../src/session-manager');

const SHOT_A = {
  DeviceID: 'GSPro LM 1.1',
  Units: 'Yards',
  ShotNumber: 13,
  APIversion: '1',
  BallData: {
    Speed: 147.5, SpinAxis: -13.2, TotalSpin: 3250.0,
    HLA: 2.3, VLA: 14.3, CarryDistance: 256.5
  },
  ClubData: { Speed: 0, AngleOfAttack: 0, FaceToTarget: 0, Path: 0 },
  ShotDataOptions: { ContainsBallData: true, ContainsClubData: false }
};

const SHOT_B = {
  DeviceID: 'GSPro LM 1.1',
  Units: 'Yards',
  ShotNumber: 14,
  APIversion: '1',
  BallData: { Speed: 152.1, SpinAxis: 4.0, TotalSpin: 2800, HLA: -1.1, VLA: 13.5, CarryDistance: 268.4 },
  ClubData: { Speed: 0, AngleOfAttack: 0, FaceToTarget: 0, Path: 0 },
  ShotDataOptions: { ContainsBallData: true, ContainsClubData: false }
};

const GSPRO_RESPONSE = JSON.stringify({ Code: 200, Message: 'Shot received successfully' }) + '\n';

function fakeGSPro({ port, onShot }) {
  return new Promise((resolve) => {
    const received = [];
    const server = net.createServer((sock) => {
      const framer = new JSONFramer();
      sock.on('data', (chunk) => {
        received.push(Buffer.from(chunk));
        const events = framer.push(chunk);
        for (const ev of events) {
          if (ev.ok) {
            onShot && onShot(ev.value);
            sock.write(GSPRO_RESPONSE);
          }
        }
      });
      sock.on('error', () => {});
    });
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        receivedBuffer: () => Buffer.concat(received),
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}

function uneekorClient({ host, port }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host, () => {
      const incoming = [];
      sock.on('data', (chunk) => incoming.push(Buffer.from(chunk)));
      resolve({
        write: (buf) => new Promise((r) => sock.write(buf, r)),
        readAll: () => Buffer.concat(incoming).toString('utf8'),
        end: () => new Promise((r) => sock.end(r))
      });
    });
    sock.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-smoke-'));
  return dir;
}

function silentLogger() {
  const noop = () => {};
  const level = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => silentLogger() };
  return level;
}

function realLogger() {
  return createLogger({ logging: { level: 'info' } });
}

async function runScenario(label, sendFn, expectedShots) {
  console.log(`\n— scenario: ${label} —`);

  const dataDir = makeTempDir();
  const gsproPort = await getFreePort();
  const relayPort = await getFreePort();

  const gsproShots = [];
  const gspro = await fakeGSPro({ port: gsproPort, onShot: (s) => gsproShots.push(s) });

  const config = {
    bay: { number: 1, optixResourceId: '609902' },
    relay: { listenHost: '127.0.0.1', listenPort: relayPort },
    gspro: { host: '127.0.0.1', port: gspro.port },
    supabase: { url: '', serviceKey: '', shotsTable: 'shots' },
    session: { inactivityTimeoutMs: 600000 },
    logging: { level: 'info' }
  };

  const logger = silentLogger();
  const persistence = createPersistence({ config, logger, dataDir });
  const relay = createRelay({ config, logger, persistence });
  await relay.listen();

  const client = await uneekorClient({ host: '127.0.0.1', port: relayPort });
  await sendFn(client);
  await sleep(250);
  await client.end();
  await sleep(100);

  await relay.close();
  await persistence.close();
  await gspro.close();

  assert.strictEqual(gsproShots.length, expectedShots.length,
    `gspro should have received ${expectedShots.length} shots, got ${gsproShots.length}`);
  for (let i = 0; i < expectedShots.length; i++) {
    assert.strictEqual(gsproShots[i].ShotNumber, expectedShots[i].ShotNumber,
      `shot ${i} number mismatch`);
  }

  const jsonl = fs.readFileSync(path.join(persistence.shotsPath), 'utf8').trim().split('\n').filter(Boolean);
  assert.strictEqual(jsonl.length, expectedShots.length,
    `jsonl should have ${expectedShots.length} lines, got ${jsonl.length}`);
  for (let i = 0; i < expectedShots.length; i++) {
    const rec = JSON.parse(jsonl[i]);
    assert.strictEqual(rec.bay_number, 1);
    assert.strictEqual(rec.session_id, null);
    assert.strictEqual(rec.player_id, null);
    assert.strictEqual(rec.shot_number, expectedShots[i].ShotNumber);
    assert.strictEqual(rec.ball_speed, expectedShots[i].BallData.Speed);
    assert.strictEqual(rec.carry_distance, expectedShots[i].BallData.CarryDistance);
    assert.strictEqual(rec.raw.ShotNumber, expectedShots[i].ShotNumber);
    assert.ok(rec.recorded_at, 'recorded_at present');
  }

  const responses = client.readAll();
  assert.ok(
    responses.includes('"Code":200'),
    `client should have received GS Pro 200 response, got: ${responses.slice(0, 200)}`
  );

  console.log(`  ✓ gspro got ${gsproShots.length} shot(s)`);
  console.log(`  ✓ jsonl wrote ${jsonl.length} record(s)`);
  console.log(`  ✓ client received GS Pro response (${responses.length} bytes)`);
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// Stateful PostgREST mock that handles every endpoint the relay touches:
// shots insert (M2), plus players upsert / sessions insert+update / shot count
// / shot backfill (M3). Each request is also recorded so tests can assert on
// payloads and headers.
function fakeSupabase({ port }) {
  return new Promise((resolve) => {
    const requests = [];
    const state = {
      players:  [],            // { id, optix_user_id, optix_member_id, email, display_name }
      sessions: [],            // { id, player_id, bay_number, optix_booking_id, started_at, ended_at, shot_count }
      shots:    []             // POSTed/PATCHed shot rows
    };
    let nextPlayerId = 1, nextSessionId = 1;
    const json = (res, status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    function parseQuery(url) {
      const i = url.indexOf('?');
      const params = new URLSearchParams(i >= 0 ? url.slice(i + 1) : '');
      // Parse PostgREST-style filters: each value is `op.value` or `is.null`.
      // For `recorded_at` there can be multiple values.
      const filters = {};
      for (const [k, v] of params.entries()) {
        if (!filters[k]) filters[k] = [];
        filters[k].push(v);
      }
      return { params, filters };
    }
    function tableFromUrl(url) {
      // /rest/v1/<table>?...
      const m = url.match(/^\/rest\/v1\/([^?]+)/);
      return m ? m[1] : null;
    }

    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf8');
        let parsedBody = null;
        try { parsedBody = bodyText ? JSON.parse(bodyText) : null; } catch (_) {}
        requests.push({ method: req.method, url: req.url, headers: req.headers, body: parsedBody ?? bodyText });

        const table = tableFromUrl(req.url);
        const { filters } = parseQuery(req.url);

        // ── players ──────────────────────────────────────────────────────
        if (table === 'players' && req.method === 'POST') {
          const incoming = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
          const out = [];
          for (const row of incoming) {
            let existing = state.players.find((p) => p.optix_user_id === row.optix_user_id);
            if (existing) {
              // merge-duplicates: refresh fields
              Object.assign(existing, row);
              out.push(existing);
            } else {
              const created = { id: `player-${nextPlayerId++}`, ...row };
              state.players.push(created);
              out.push(created);
            }
          }
          return json(res, 201, out);
        }

        // ── sessions ─────────────────────────────────────────────────────
        if (table === 'sessions' && req.method === 'GET') {
          const matches = state.sessions.filter((s) => {
            if (filters.bay_number && filters.bay_number[0] !== `eq.${s.bay_number}`) return false;
            if (filters.optix_booking_id && filters.optix_booking_id[0] !== `eq.${s.optix_booking_id}`) return false;
            if (filters.ended_at) {
              const wantNull = filters.ended_at[0] === 'is.null';
              if (wantNull && s.ended_at != null) return false;
              if (!wantNull && s.ended_at == null) return false;
            }
            return true;
          });
          return json(res, 200, matches);
        }
        if (table === 'sessions' && req.method === 'POST') {
          const rows = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
          const out = rows.map((r) => {
            const created = {
              id: `session-${nextSessionId++}`,
              ended_at: null,
              shot_count: 0,
              ...r
            };
            state.sessions.push(created);
            return created;
          });
          return json(res, 201, out);
        }
        if (table === 'sessions' && req.method === 'PATCH') {
          const idEq = filters.id && filters.id[0]; // "eq.<id>"
          const id = idEq && idEq.replace(/^eq\./, '');
          const target = state.sessions.find((s) => s.id === id);
          if (target) Object.assign(target, parsedBody);
          return json(res, 200, target ? [target] : []);
        }

        // ── shots ────────────────────────────────────────────────────────
        if (table === 'shots' && req.method === 'POST') {
          if (Array.isArray(parsedBody)) state.shots.push(...parsedBody);
          else if (parsedBody) state.shots.push(parsedBody);
          return json(res, 201, '');
        }
        if (table === 'shots' && req.method === 'GET') {
          // shot count probe: select=id&limit=0 with Prefer: count=exact
          const sessionEq = filters.session_id && filters.session_id[0];
          if (sessionEq) {
            const id = sessionEq.replace(/^eq\./, '');
            const total = state.shots.filter((s) => s.session_id === id).length;
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Content-Range': `0-/${total}`
            });
            return res.end('[]');
          }
          return json(res, 200, []);
        }
        if (table === 'shots' && req.method === 'PATCH') {
          // backfill: update rows matching all filters
          const updated = [];
          for (const s of state.shots) {
            if (filters.bay_number && filters.bay_number[0] !== `eq.${s.bay_number}`) continue;
            if (filters.session_id && filters.session_id[0] === 'is.null' && s.session_id != null) continue;
            if (filters.recorded_at) {
              for (const f of filters.recorded_at) {
                const [op, ...rest] = f.split('.');
                const val = rest.join('.');
                if (op === 'gte' && s.recorded_at < val) { s.__skip = true; break; }
                if (op === 'lt'  && s.recorded_at >= val) { s.__skip = true; break; }
              }
              if (s.__skip) { delete s.__skip; continue; }
            }
            Object.assign(s, parsedBody);
            updated.push(s);
          }
          return json(res, 200, updated);
        }

        // Default: empty 200 (covers health-check probes that hit /rest/v1/<table>?select=id&limit=1)
        json(res, 200, []);
      });
    });
    server.listen(port, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        state,
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}

// Programmable Optix GraphQL mock. Drive the response via state.currentByResource
// keyed by resource_id (string). Set state.errorMode = 'http_500' or 'graphql_error'
// to simulate failures.
function fakeOptix({ port, state }) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(bodyText); } catch (_) {}
        requests.push({ method: req.method, url: req.url, headers: req.headers, body: parsed });

        if (state.errorMode === 'http_500') {
          res.writeHead(500); return res.end('boom');
        }
        if (state.errorMode === 'graphql_error') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ errors: [{ message: 'simulated error' }] }));
        }
        const variables = parsed?.variables || {};
        const rid = String(variables.resource_id || '');
        const booking = state.currentByResource[rid] || null;
        const data = {
          bookings: {
            total: booking ? 1 : 0,
            data: booking ? [booking] : []
          }
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data }));
      });
    });
    server.listen(port, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/graphql`,
        requests,
        state,
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}

function makeBooking({ booking_id, user_id = '762951', email = 'kyle@example.com', fullname = 'Kyle Peterson', account_id = '449823', start = null, end = null }) {
  const now = Math.floor(Date.now() / 1000);
  return {
    booking_id,
    start_timestamp: start ?? (now - 60),
    end_timestamp:   end   ?? (now + 7200),
    is_canceled:     false,
    account: { account_id },
    user:    { user_id, email, fullname },
    resource: { resource_id: '609902' }
  };
}

async function supabaseScenario() {
  console.log('\n— scenario: supabase POST + health check (fake server) —');

  const dataDir = makeTempDir();
  const gspro = await fakeGSPro({ port: await getFreePort(), onShot: () => {} });
  const supa = await fakeSupabase({ port: await getFreePort() });
  const relayPort = await getFreePort();

  const config = {
    bay: { number: 2, optixResourceId: '619992' },
    relay: { listenHost: '127.0.0.1', listenPort: relayPort },
    gspro: { host: '127.0.0.1', port: gspro.port },
    supabase: { url: supa.url, serviceKey: 'fake-service-role-key', shotsTable: 'shots' },
    session: { inactivityTimeoutMs: 600000 },
    logging: { level: 'info' }
  };

  const logger = silentLogger();
  const persistence = createPersistence({ config, logger, dataDir });
  const relay = createRelay({ config, logger, persistence });
  await relay.listen();

  const health = await persistence.healthCheck();
  assert.strictEqual(health.ok, true, 'health check should succeed against fake supabase');

  const client = await uneekorClient({ host: '127.0.0.1', port: relayPort });
  await client.write(JSON.stringify(SHOT_A));
  await sleep(250);
  await client.end();
  await sleep(150);

  await relay.close();
  await persistence.close();
  await gspro.close();
  await supa.close();

  const inserts = supa.requests.filter((r) => r.method === 'POST');
  assert.strictEqual(inserts.length, 1, `expected 1 POST insert, got ${inserts.length}`);
  const insert = inserts[0];
  assert.ok(insert.url.endsWith('/rest/v1/shots'), `unexpected insert URL: ${insert.url}`);
  assert.strictEqual(insert.headers['apikey'], 'fake-service-role-key');
  assert.strictEqual(insert.headers['authorization'], 'Bearer fake-service-role-key');
  assert.strictEqual(insert.headers['prefer'], 'return=minimal');
  assert.strictEqual(insert.body.bay_number, 2);
  assert.strictEqual(insert.body.session_id, null);
  assert.strictEqual(insert.body.player_id, null);
  assert.strictEqual(insert.body.shot_number, SHOT_A.ShotNumber);
  assert.strictEqual(insert.body.ball_speed, SHOT_A.BallData.Speed);
  assert.strictEqual(insert.body.carry_distance, SHOT_A.BallData.CarryDistance);
  assert.strictEqual(insert.body.hla, SHOT_A.BallData.HLA);
  assert.strictEqual(insert.body.vla, SHOT_A.BallData.VLA);
  assert.strictEqual(insert.body.total_spin, SHOT_A.BallData.TotalSpin);
  assert.strictEqual(insert.body.spin_axis, SHOT_A.BallData.SpinAxis);
  assert.strictEqual(insert.body.raw.ShotNumber, SHOT_A.ShotNumber);
  assert.ok(insert.body.recorded_at, 'recorded_at present in insert payload');

  console.log('  ✓ health check returned ok');
  console.log('  ✓ shot POSTed to /rest/v1/shots with apikey + Bearer headers');
  console.log('  ✓ flattened columns match BallData/ClubData fields');
}

async function supabaseDownDoesNotBlockStartupScenario() {
  console.log('\n— scenario: supabase failure does not block relay startup —');

  const dataDir = makeTempDir();
  const gspro = await fakeGSPro({ port: await getFreePort(), onShot: () => {} });
  const relayPort = await getFreePort();
  const deadSupabasePort = await getFreePort();

  const config = {
    bay: { number: 1, optixResourceId: '609902' },
    relay: { listenHost: '127.0.0.1', listenPort: relayPort },
    gspro: { host: '127.0.0.1', port: gspro.port },
    supabase: { url: `http://127.0.0.1:${deadSupabasePort}`, serviceKey: 'fake-key', shotsTable: 'shots' },
    session: { inactivityTimeoutMs: 600000 },
    logging: { level: 'info' }
  };

  const logger = silentLogger();
  const persistence = createPersistence({ config, logger, dataDir });
  const relay = createRelay({ config, logger, persistence });

  const t0 = Date.now();
  await relay.listen();
  const listenMs = Date.now() - t0;
  assert.ok(listenMs < 500, `relay.listen() should not wait on supabase, took ${listenMs}ms`);

  const health = await persistence.healthCheck();
  assert.strictEqual(health.ok, false, 'health check should fail against dead supabase');
  assert.ok(health.error, 'health check should surface an error message');

  // Send a shot — it must still land in JSONL even though supabase is down.
  const client = await uneekorClient({ host: '127.0.0.1', port: relayPort });
  await client.write(JSON.stringify(SHOT_A));
  await sleep(200);
  await client.end();
  await sleep(150);

  await relay.close();
  await persistence.close();
  await gspro.close();

  const lines = fs.readFileSync(persistence.shotsPath, 'utf8').trim().split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 1, `jsonl should still have 1 line, got ${lines.length}`);

  console.log(`  ✓ relay listened in ${listenMs}ms (no supabase wait)`);
  console.log('  ✓ health check reported failure cleanly');
  console.log('  ✓ shot still persisted to local JSONL');
}

async function failOpenScenario() {
  console.log('\n— scenario: fail-open when GS Pro is unreachable —');

  const dataDir = makeTempDir();
  const relayPort = await getFreePort();
  const deadGsproPort = await getFreePort();

  const config = {
    bay: { number: 1, optixResourceId: '609902' },
    relay: { listenHost: '127.0.0.1', listenPort: relayPort },
    gspro: { host: '127.0.0.1', port: deadGsproPort },
    supabase: { url: '', serviceKey: '', shotsTable: 'shots' },
    session: { inactivityTimeoutMs: 600000 },
    logging: { level: 'info' }
  };

  const logger = silentLogger();
  const persistence = createPersistence({ config, logger, dataDir });
  const relay = createRelay({ config, logger, persistence });
  await relay.listen();

  let connectionClosed = false;
  const sock = net.connect(relayPort, '127.0.0.1');
  sock.on('close', () => { connectionClosed = true; });
  sock.on('error', () => {});
  await sleep(200);
  sock.write(JSON.stringify(SHOT_A) + '\n');
  await sleep(300);

  assert.ok(connectionClosed, 'uneekor side should be closed when gspro is unreachable');

  await relay.close();
  await persistence.close();

  console.log('  ✓ relay process survived unreachable GS Pro');
  console.log('  ✓ uneekor connection cleanly torn down');
}

// ─── M3 helpers ─────────────────────────────────────────────────────────────

async function setupM3() {
  const optixState = { currentByResource: {}, errorMode: null };
  const optix = await fakeOptix({ port: await getFreePort(), state: optixState });
  const supa  = await fakeSupabase({ port: await getFreePort() });
  const config = {
    bay: { number: 1, optixResourceId: '609902' },
    relay: { listenHost: '127.0.0.1', listenPort: 0 },
    gspro: { host: '127.0.0.1', port: 0 },
    supabase: { url: supa.url, serviceKey: 'fake-key', shotsTable: 'shots' },
    optix:    { graphqlUrl: optix.url, orgToken: 'fake-org-tokeno', pollIntervalMs: 60000, fetchTimeoutMs: 5000 },
    session:  { inactivityTimeoutMs: 600000, backfillWindowMs: 60000 },
    logging:  { level: 'info' }
  };
  const logger = silentLogger();
  const supabase = createSupabaseClient({ config, logger });
  const optixClient = createOptixClient({ config, logger });
  const sessionManager = createSessionManager({ config, logger, optixClient, supabase });
  return { optix, supa, optixState, config, logger, supabase, optixClient, sessionManager };
}

async function teardownM3({ optix, supa, sessionManager }) {
  await sessionManager.stop();
  await optix.close();
  await supa.close();
}

// ─── M3 scenarios ───────────────────────────────────────────────────────────

async function sessionOpensOnFirstPollScenario() {
  console.log('\n— scenario: session opens when poll finds active booking —');
  const ctx = await setupM3();
  ctx.optixState.currentByResource['609902'] = makeBooking({ booking_id: 'bk-1' });

  await ctx.sessionManager._runPollOnce();

  const tag = ctx.sessionManager.getCurrentTag();
  assert.ok(tag, 'tag should be set after session opens');
  assert.ok(tag.session_id.startsWith('session-'), 'session_id assigned');
  assert.ok(tag.player_id.startsWith('player-'), 'player_id assigned');

  // Player upsert payload check
  const playerPosts = ctx.supa.requests.filter((r) => r.method === 'POST' && r.url.startsWith('/rest/v1/players'));
  assert.strictEqual(playerPosts.length, 1, `expected 1 player upsert, got ${playerPosts.length}`);
  const p = Array.isArray(playerPosts[0].body) ? playerPosts[0].body[0] : playerPosts[0].body;
  assert.strictEqual(p.optix_user_id, '762951');
  assert.strictEqual(p.optix_member_id, '449823');
  assert.strictEqual(p.email, 'kyle@example.com');
  assert.strictEqual(p.display_name, 'Kyle Peterson');
  assert.ok(playerPosts[0].url.includes('on_conflict=optix_user_id'), 'upsert uses on_conflict');

  // Session insert payload check
  const sessionPosts = ctx.supa.requests.filter((r) => r.method === 'POST' && r.url.startsWith('/rest/v1/sessions'));
  assert.strictEqual(sessionPosts.length, 1, `expected 1 session insert, got ${sessionPosts.length}`);
  const s = Array.isArray(sessionPosts[0].body) ? sessionPosts[0].body[0] : sessionPosts[0].body;
  assert.strictEqual(s.bay_number, 1);
  assert.strictEqual(s.optix_booking_id, 'bk-1');
  assert.ok(s.player_id.startsWith('player-'));
  assert.ok(s.started_at, 'started_at present');

  await teardownM3(ctx);
  console.log('  ✓ player upserted with optix ids + email + name');
  console.log('  ✓ session row inserted with player_id + optix_booking_id');
  console.log('  ✓ getCurrentTag returns {session_id, player_id}');
}

async function sessionStaysOpenAcrossPollsScenario() {
  console.log('\n— scenario: session stays open across multiple polls of same booking —');
  const ctx = await setupM3();
  ctx.optixState.currentByResource['609902'] = makeBooking({ booking_id: 'bk-stay' });

  await ctx.sessionManager._runPollOnce();
  const tag1 = ctx.sessionManager.getCurrentTag();
  await ctx.sessionManager._runPollOnce();
  const tag2 = ctx.sessionManager.getCurrentTag();
  await ctx.sessionManager._runPollOnce();
  const tag3 = ctx.sessionManager.getCurrentTag();

  assert.deepStrictEqual(tag1, tag2);
  assert.deepStrictEqual(tag2, tag3);

  const sessionPosts = ctx.supa.requests.filter((r) => r.method === 'POST' && r.url.startsWith('/rest/v1/sessions'));
  assert.strictEqual(sessionPosts.length, 1, `should not create duplicate session rows, got ${sessionPosts.length}`);

  await teardownM3(ctx);
  console.log('  ✓ tag stable across 3 polls');
  console.log('  ✓ only one sessions row inserted');
}

async function sessionClosesWhenBookingEndsScenario() {
  console.log('\n— scenario: session closes when poll returns no booking —');
  const ctx = await setupM3();
  ctx.optixState.currentByResource['609902'] = makeBooking({ booking_id: 'bk-end' });

  await ctx.sessionManager._runPollOnce();
  assert.ok(ctx.sessionManager.getCurrentTag(), 'tag set after open');
  const openSession = ctx.supa.state.sessions[0];
  const sessionId = openSession.id;

  // Booking gone next poll
  ctx.optixState.currentByResource['609902'] = null;
  await ctx.sessionManager._runPollOnce();

  assert.strictEqual(ctx.sessionManager.getCurrentTag(), null, 'tag cleared after close');

  const closed = ctx.supa.state.sessions.find((s) => s.id === sessionId);
  assert.ok(closed.ended_at, 'ended_at set');
  assert.strictEqual(closed.shot_count, 0, 'shot_count finalized (0 in this test)');

  await teardownM3(ctx);
  console.log('  ✓ tag cleared, sessions row updated with ended_at + shot_count');
}

async function backfillScenario() {
  console.log('\n— scenario: backfill rewrites pre-session NULL shots within window —');
  const ctx = await setupM3();

  // Pre-stage shot rows in fake supabase: 1 inside the window, 1 outside.
  const nowIso = new Date().toISOString();
  const recentIso = new Date(Date.now() - 30_000).toISOString();   // 30s ago — inside 60s window
  const oldIso    = new Date(Date.now() - 5 * 60_000).toISOString(); // 5min ago — outside window
  ctx.supa.state.shots.push(
    { id: 's-recent', bay_number: 1, session_id: null, player_id: null, recorded_at: recentIso },
    { id: 's-old',    bay_number: 1, session_id: null, player_id: null, recorded_at: oldIso }
  );

  ctx.optixState.currentByResource['609902'] = makeBooking({ booking_id: 'bk-back' });
  await ctx.sessionManager._runPollOnce();

  const tag = ctx.sessionManager.getCurrentTag();
  assert.ok(tag);

  const recent = ctx.supa.state.shots.find((s) => s.id === 's-recent');
  const old    = ctx.supa.state.shots.find((s) => s.id === 's-old');
  assert.strictEqual(recent.session_id, tag.session_id, 'recent shot backfilled with session_id');
  assert.strictEqual(recent.player_id,  tag.player_id,  'recent shot backfilled with player_id');
  assert.strictEqual(old.session_id, null, 'old shot stays null (outside window)');
  assert.strictEqual(old.player_id,  null, 'old shot stays null (outside window)');

  await teardownM3(ctx);
  console.log('  ✓ shot recorded 30s ago tagged on session open');
  console.log('  ✓ shot recorded 5min ago left untouched');
}

async function inactivityTimeoutScenario() {
  console.log('\n— scenario: inactivity timeout closes session as safety net —');
  const ctx = await setupM3();
  // Override inactivity to 200ms for fast test
  ctx.config.session.inactivityTimeoutMs = 200;
  // Recreate session manager with the overridden config
  await ctx.sessionManager.stop();
  ctx.sessionManager = createSessionManager({
    config: ctx.config, logger: ctx.logger, optixClient: ctx.optixClient, supabase: ctx.supabase
  });

  ctx.optixState.currentByResource['609902'] = makeBooking({ booking_id: 'bk-idle' });
  await ctx.sessionManager._runPollOnce();
  assert.ok(ctx.sessionManager.getCurrentTag(), 'session opened');

  await sleep(350);  // longer than 200ms inactivity threshold
  assert.strictEqual(ctx.sessionManager.getCurrentTag(), null, 'session auto-closed by inactivity timer');

  await teardownM3(ctx);
  console.log('  ✓ session closes after configured inactivity threshold');
}

async function optixErrorDoesNotCrashScenario() {
  console.log('\n— scenario: optix HTTP/GraphQL errors do not change state ­or crash —');
  const ctx = await setupM3();

  // Open a session first
  ctx.optixState.currentByResource['609902'] = makeBooking({ booking_id: 'bk-stable' });
  await ctx.sessionManager._runPollOnce();
  assert.ok(ctx.sessionManager.getCurrentTag());
  const tagBefore = { ...ctx.sessionManager.getCurrentTag() };

  // Now flip Optix into HTTP 500 — state should hold steady
  ctx.optixState.errorMode = 'http_500';
  await ctx.sessionManager._runPollOnce();
  assert.deepStrictEqual(ctx.sessionManager.getCurrentTag(), tagBefore, 'state unchanged on HTTP 500');

  ctx.optixState.errorMode = 'graphql_error';
  await ctx.sessionManager._runPollOnce();
  assert.deepStrictEqual(ctx.sessionManager.getCurrentTag(), tagBefore, 'state unchanged on GraphQL error');

  // Recover and roll forward
  ctx.optixState.errorMode = null;
  ctx.optixState.currentByResource['609902'] = null;
  await ctx.sessionManager._runPollOnce();
  assert.strictEqual(ctx.sessionManager.getCurrentTag(), null, 'closes once optix recovers and reports no booking');

  await teardownM3(ctx);
  console.log('  ✓ HTTP 500 from optix does not change state');
  console.log('  ✓ GraphQL errors response does not change state');
  console.log('  ✓ recovery transitions state correctly');
}

async function resumeOpenSessionOnRestartScenario() {
  console.log('\n— scenario: relay restart resumes existing open session for same booking —');
  const ctx = await setupM3();

  // Pre-existing open session in supabase (simulating a restart)
  ctx.supa.state.players.push({
    id: 'player-existing', optix_user_id: '762951', optix_member_id: '449823',
    email: 'kyle@example.com', display_name: 'Kyle Peterson'
  });
  ctx.supa.state.sessions.push({
    id: 'session-existing',
    player_id: 'player-existing',
    bay_number: 1,
    optix_booking_id: 'bk-resume',
    started_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    ended_at: null,
    shot_count: 0
  });
  // Booking still active
  ctx.optixState.currentByResource['609902'] = makeBooking({ booking_id: 'bk-resume' });

  await ctx.sessionManager._runPollOnce();

  const tag = ctx.sessionManager.getCurrentTag();
  assert.strictEqual(tag.session_id, 'session-existing', 'reuses existing session id');
  assert.strictEqual(tag.player_id, 'player-existing',  'reuses existing player id');

  const sessionInserts = ctx.supa.requests.filter((r) => r.method === 'POST' && r.url.startsWith('/rest/v1/sessions'));
  assert.strictEqual(sessionInserts.length, 0, 'no new session row created');

  await teardownM3(ctx);
  console.log('  ✓ resumed existing session row by optix_booking_id + bay_number');
  console.log('  ✓ no duplicate sessions row inserted');
}

async function shotTaggingScenario() {
  console.log('\n— scenario: shots arriving during open session get tagged in real time —');
  const ctx = await setupM3();
  const dataDir = makeTempDir();

  ctx.optixState.currentByResource['609902'] = makeBooking({ booking_id: 'bk-tag' });
  await ctx.sessionManager._runPollOnce();
  const tag = ctx.sessionManager.getCurrentTag();
  assert.ok(tag, 'session open');

  // Build persistence wired to sessionManager
  const persistence = createPersistence({
    config: ctx.config,
    logger: ctx.logger,
    dataDir,
    supabase: ctx.supabase,
    getTag: () => ctx.sessionManager.getCurrentTag()
  });
  persistence.saveShot(SHOT_A);
  ctx.sessionManager.noteShot();
  await sleep(150);  // let supabase POST flush

  const shotInserts = ctx.supa.requests.filter((r) => r.method === 'POST' && r.url.startsWith('/rest/v1/shots'));
  assert.strictEqual(shotInserts.length, 1);
  assert.strictEqual(shotInserts[0].body.session_id, tag.session_id, 'shot tagged with session_id');
  assert.strictEqual(shotInserts[0].body.player_id,  tag.player_id,  'shot tagged with player_id');

  await persistence.close();
  await teardownM3(ctx);
  console.log('  ✓ shot inserted with session_id + player_id from session manager');
}

(async () => {
  try {
    await runScenario(
      'single shot in one TCP write',
      async (c) => { await c.write(JSON.stringify(SHOT_A)); },
      [SHOT_A]
    );

    await runScenario(
      'single shot split across two TCP writes',
      async (c) => {
        const payload = JSON.stringify(SHOT_A);
        const split = Math.floor(payload.length / 2);
        await c.write(payload.slice(0, split));
        await sleep(40);
        await c.write(payload.slice(split));
      },
      [SHOT_A]
    );

    await runScenario(
      'two shots back-to-back in one TCP write (newline-delimited)',
      async (c) => {
        await c.write(JSON.stringify(SHOT_A) + '\n' + JSON.stringify(SHOT_B) + '\n');
      },
      [SHOT_A, SHOT_B]
    );

    await runScenario(
      'two shots back-to-back, no separator',
      async (c) => {
        await c.write(JSON.stringify(SHOT_A) + JSON.stringify(SHOT_B));
      },
      [SHOT_A, SHOT_B]
    );

    await failOpenScenario();
    await supabaseScenario();
    await supabaseDownDoesNotBlockStartupScenario();
    await sessionOpensOnFirstPollScenario();
    await sessionStaysOpenAcrossPollsScenario();
    await sessionClosesWhenBookingEndsScenario();
    await backfillScenario();
    await inactivityTimeoutScenario();
    await optixErrorDoesNotCrashScenario();
    await resumeOpenSessionOnRestartScenario();
    await shotTaggingScenario();

    console.log('\nall smoke scenarios passed ✓');
    process.exit(0);
  } catch (err) {
    console.error('\nSMOKE FAILED');
    console.error(err.stack || err.message);
    process.exit(1);
  }
})();
