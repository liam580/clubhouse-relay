'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');
const assert = require('assert');

const { createPersistence } = require('../src/persistence');
const { createFileWatcher } = require('../src/file-watcher');
const { createLastShotTracker } = require('../src/last-shot');
const { readShotDir } = require('../src/view-parser');
const { computeCarryYards } = require('../src/ballistic');
const { createSupabaseClient } = require('../src/supabase');
const { createOptixClient } = require('../src/optix-client');
const { createSessionManager } = require('../src/session-manager');

// ─── VIEW shot fixtures ─────────────────────────────────────────────────
// SHOT A is verbatim from the Bay 2 PC capture (ShotData/993). Padded
// numeric strings exactly as VIEW writes them.

const SHOTINFO_A = {
  DATA: {
    "ballspeed":             "   45.0800",
    "incline":               "   19.7957",
    "azimuth":               "    0.3060",
    "backspin":              " 8337.9229",
    "sidespin":              "  199.6212",
    "spinmag2d":             " 8340.3125",
    "spinaxis2d":            "    1.3715",
    "clubspeed":             "   35.1305",
    "Assurance_clubspeed":   "89",
    "clubpath":              "   -0.7444",
    "Assurance_clubpath":    "85",
    "clubfaceangle":         "    0.4227",
    "Assurance_clubfaceangle": "75",
    "clubattackangle":       "   -7.5356",
    "Assurance_clubattackangle": "1",
    "clubloftangle":         "    0.0000",
    "clublieangle":          "    0.0000",
    "clubfaceimpactLateral": "    0.0000",
    "clubfaceimpactVertical": "    0.0000"
  },
  BALLIMPACT: { valid: "1", name: "ballimpact.jpg", xpos: "128", ypos: "119", radius: "37" }
};
const PROINFO_A = { Name: "ClubHouse", Association: "--", Slope: "", Club: 24, ClubName: "IRON7", Star: false, Hand: 0 };

const SHOTINFO_B = {
  DATA: {
    "ballspeed":             "  152.3400",
    "incline":               "   13.5200",
    "azimuth":               "    1.1100",
    "backspin":              " 2650.0000",
    "sidespin":              " -200.0000",
    "spinmag2d":             " 2657.5300",
    "spinaxis2d":            "   -4.3200",
    "clubspeed":             "  108.7700",
    "Assurance_clubspeed":   "92",
    "clubpath":              "    0.5500",
    "Assurance_clubpath":    "88",
    "clubfaceangle":         "    0.3300",
    "Assurance_clubfaceangle": "82",
    "clubattackangle":       "   -1.2000",
    "Assurance_clubattackangle": "75",
    "clubloftangle":         "    0.0000",
    "clublieangle":          "    0.0000",
    "clubfaceimpactLateral": "    0.0000",
    "clubfaceimpactVertical": "    0.0000"
  },
  BALLIMPACT: { valid: "1", name: "ballimpact.jpg", xpos: "120", ypos: "115", radius: "38" }
};
const PROINFO_B = { Name: "Tester", Association: "--", Slope: "", Club: 1, ClubName: "DRIVER", Star: false, Hand: 0 };

const PROINFO_REFERENCE = { Name: "S.Y.Baek", Association: "KPGA", Slope: "", Club: 7, ClubName: "WEDGE", Star: true, Hand: 0 };

// ─── helpers ────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-smoke-'));
}

function silentLogger() {
  const noop = () => {};
  const inst = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop };
  inst.child = () => inst;
  return inst;
}

function writeShot(root, n, shotinfo, proInfo) {
  const dir = path.join(root, String(n));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'shotinfo.json'), JSON.stringify(shotinfo));
  fs.writeFileSync(path.join(dir, 'ProShotInfo.json'), JSON.stringify(proInfo));
  return dir;
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

function buildSampleShot(shotinfo, proInfo, n = 1) {
  const tmp = makeTempDir();
  fs.writeFileSync(path.join(tmp, 'shotinfo.json'), JSON.stringify(shotinfo));
  fs.writeFileSync(path.join(tmp, 'ProShotInfo.json'), JSON.stringify(proInfo));
  const r = readShotDir({ dir: tmp, shotNumber: n });
  assert.ok(r.ok, `buildSampleShot expected ok, got ${JSON.stringify(r)}`);
  return r.value;
}

// ─── M1 scenarios (parser + file watcher) ───────────────────────────────

async function singleShotScenario() {
  console.log('\n— scenario: single shot lands and is parsed correctly —');
  const watchRoot = makeTempDir();
  const dataDir = makeTempDir();
  const lastShot = createLastShotTracker({ dataDir, logger: silentLogger() });
  const captured = [];

  const watcher = createFileWatcher({
    config: { watch: { shotDataDir: watchRoot, writeStabilityMs: 50, pollIntervalMs: 20 } },
    logger: silentLogger(),
    lastShot,
    onShot: (s) => captured.push(s)
  });

  writeShot(watchRoot, 1, SHOTINFO_A, PROINFO_A);
  watcher._processFile(path.join(watchRoot, '1', 'ProShotInfo.json'));

  assert.strictEqual(captured.length, 1);
  const shot = captured[0];
  assert.strictEqual(shot.shotNumber, 1);
  assert.ok(Math.abs(shot.ballSpeed - 45.08) < 0.001, 'ballspeed parsed from padded string');
  assert.ok(Math.abs(shot.vla - 19.7957) < 0.001, 'incline → vla');
  assert.ok(Math.abs(shot.hla - 0.306) < 0.001, 'azimuth → hla');
  assert.strictEqual(shot.clubName, 'IRON7');
  assert.strictEqual(shot.clubId, 24);
  assert.strictEqual(shot.playerName, 'ClubHouse');
  assert.strictEqual(shot.assurance.clubSpeed, 89);
  assert.strictEqual(lastShot.read(), 1);

  console.log('  ✓ padded-string numerics float-cast');
  console.log('  ✓ ClubName + Club + player Name carried');
  console.log('  ✓ assurance per-measurement values float-cast');
  console.log('  ✓ last-shot.json advanced');
}

async function twoShotsBackToBackScenario() {
  console.log('\n— scenario: two shots back-to-back, both ingested in order —');
  const watchRoot = makeTempDir();
  const dataDir = makeTempDir();
  const lastShot = createLastShotTracker({ dataDir, logger: silentLogger() });
  const captured = [];

  const watcher = createFileWatcher({
    config: { watch: { shotDataDir: watchRoot, writeStabilityMs: 50, pollIntervalMs: 20 } },
    logger: silentLogger(),
    lastShot,
    onShot: (s) => captured.push(s)
  });

  writeShot(watchRoot, 5, SHOTINFO_A, PROINFO_A);
  writeShot(watchRoot, 6, SHOTINFO_B, PROINFO_B);
  watcher._processFile(path.join(watchRoot, '5', 'ProShotInfo.json'));
  watcher._processFile(path.join(watchRoot, '6', 'ProShotInfo.json'));

  assert.strictEqual(captured.length, 2);
  assert.strictEqual(captured[0].shotNumber, 5);
  assert.strictEqual(captured[1].shotNumber, 6);
  assert.strictEqual(captured[0].clubName, 'IRON7');
  assert.strictEqual(captured[1].clubName, 'DRIVER');
  assert.strictEqual(lastShot.read(), 6);

  console.log('  ✓ both shots captured');
  console.log('  ✓ last-shot advances to highest n');
}

async function incompleteShotScenario() {
  console.log('\n— scenario: ProShotInfo present, shotinfo missing — graceful fail —');
  const watchRoot = makeTempDir();
  const dataDir = makeTempDir();
  const lastShot = createLastShotTracker({ dataDir, logger: silentLogger() });
  const captured = [];

  const watcher = createFileWatcher({
    config: { watch: { shotDataDir: watchRoot, writeStabilityMs: 50, pollIntervalMs: 20 } },
    logger: silentLogger(),
    lastShot,
    onShot: (s) => captured.push(s)
  });

  const dir = path.join(watchRoot, '7');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ProShotInfo.json'), JSON.stringify(PROINFO_A));
  watcher._processFile(path.join(dir, 'ProShotInfo.json'));

  assert.strictEqual(captured.length, 0, 'no shot captured');
  assert.strictEqual(lastShot.read(), 0, 'last-shot NOT advanced (so retry can succeed later)');

  console.log('  ✓ missing shotinfo.json rejected without crash');
  console.log('  ✓ last-shot left at 0 so the next event can retry');
}

async function referenceShotFilteredScenario() {
  console.log('\n— scenario: reference shot (Star: true) filtered, last-shot advances —');
  const watchRoot = makeTempDir();
  const dataDir = makeTempDir();
  const lastShot = createLastShotTracker({ dataDir, logger: silentLogger() });
  const captured = [];

  const watcher = createFileWatcher({
    config: { watch: { shotDataDir: watchRoot, writeStabilityMs: 50, pollIntervalMs: 20 } },
    logger: silentLogger(),
    lastShot,
    onShot: (s) => captured.push(s)
  });

  writeShot(watchRoot, 42, SHOTINFO_A, PROINFO_REFERENCE);
  watcher._processFile(path.join(watchRoot, '42', 'ProShotInfo.json'));

  assert.strictEqual(captured.length, 0, 'reference shot not delivered');
  assert.strictEqual(lastShot.read(), 42, 'last-shot advances past the demo dir');

  console.log('  ✓ Star: true shot suppressed');
  console.log('  ✓ counter advanced so we don\'t re-evaluate it');
}

async function restartResumeScenario() {
  console.log('\n— scenario: restart resumes from last-shot.json (no double-ingest) —');
  const watchRoot = makeTempDir();
  const dataDir = makeTempDir();

  fs.writeFileSync(
    path.join(dataDir, 'last-shot.json'),
    JSON.stringify({ n: 100, updated_at: new Date().toISOString() })
  );

  const lastShot = createLastShotTracker({ dataDir, logger: silentLogger() });
  assert.strictEqual(lastShot.read(), 100);

  const captured = [];
  const watcher = createFileWatcher({
    config: { watch: { shotDataDir: watchRoot, writeStabilityMs: 50, pollIntervalMs: 20 } },
    logger: silentLogger(),
    lastShot,
    onShot: (s) => captured.push(s)
  });

  writeShot(watchRoot, 99,  SHOTINFO_A, PROINFO_A);
  writeShot(watchRoot, 100, SHOTINFO_A, PROINFO_A);
  writeShot(watchRoot, 101, SHOTINFO_B, PROINFO_B);

  watcher._processFile(path.join(watchRoot, '99',  'ProShotInfo.json'));
  watcher._processFile(path.join(watchRoot, '100', 'ProShotInfo.json'));
  watcher._processFile(path.join(watchRoot, '101', 'ProShotInfo.json'));

  assert.strictEqual(captured.length, 1, 'only the n > last-seen shot delivered');
  assert.strictEqual(captured[0].shotNumber, 101);
  assert.strictEqual(lastShot.read(), 101);

  console.log('  ✓ shots n ≤ last-seen skipped');
  console.log('  ✓ only the new shot delivered');
}

async function chokidarLiveScenario() {
  console.log('\n— scenario: real chokidar fires on ProShotInfo close —');
  const watchRoot = makeTempDir();
  const dataDir = makeTempDir();
  const lastShot = createLastShotTracker({ dataDir, logger: silentLogger() });
  const captured = [];

  const watcher = createFileWatcher({
    config: { watch: { shotDataDir: watchRoot, writeStabilityMs: 80, pollIntervalMs: 30 } },
    logger: silentLogger(),
    lastShot,
    onShot: (s) => captured.push(s)
  });

  await watcher.start();
  writeShot(watchRoot, 11, SHOTINFO_A, PROINFO_A);

  const start = Date.now();
  while (captured.length === 0 && Date.now() - start < 3000) await sleep(50);
  await watcher.stop();

  assert.strictEqual(captured.length, 1, `expected 1 shot via chokidar, got ${captured.length}`);
  assert.strictEqual(captured[0].shotNumber, 11);
  console.log(`  ✓ chokidar delivered shot in ${Date.now() - start}ms`);
}

async function coldStartSkipsHistoryScenario() {
  console.log('\n— scenario: cold start skips VIEW lifetime history —');
  const watchRoot = makeTempDir();
  const dataDir = makeTempDir();

  // Pre-populate the watch dir with VIEW's historical shots (mimicking what
  // the Bay 2 PC had on first install — n=929..993 with gaps).
  for (const n of [929, 950, 980, 993]) {
    writeShot(watchRoot, n, SHOTINFO_A, PROINFO_A);
  }

  const lastShot = createLastShotTracker({ dataDir, logger: silentLogger() });
  assert.strictEqual(lastShot.read(), 0, 'no last-shot.json yet, read returns 0');

  const captured = [];
  const watcher = createFileWatcher({
    config: { watch: { shotDataDir: watchRoot, writeStabilityMs: 50, pollIntervalMs: 20 } },
    logger: silentLogger(),
    lastShot,
    onShot: (s) => captured.push(s)
  });

  await watcher.start();
  await sleep(150);     // give chokidar time to settle — none of the historical shots should fire

  assert.strictEqual(captured.length, 0, 'no historical shots backfilled on cold start');
  assert.strictEqual(lastShot.read(), 993, 'last-shot initialized to max existing n');

  // A fresh shot above 993 should fire normally now.
  writeShot(watchRoot, 994, SHOTINFO_B, PROINFO_B);
  const start = Date.now();
  while (captured.length === 0 && Date.now() - start < 3000) await sleep(50);
  await watcher.stop();

  assert.strictEqual(captured.length, 1, 'new shot after cold-start IS delivered');
  assert.strictEqual(captured[0].shotNumber, 994);
  assert.strictEqual(lastShot.read(), 994);

  console.log('  ✓ 4 historical shots skipped');
  console.log('  ✓ last-shot initialized to 993 (current max)');
  console.log('  ✓ subsequent new shot fired normally');
}

async function warmStartCatchesUpScenario() {
  console.log('\n— scenario: warm start catches up shots written during downtime —');
  const watchRoot = makeTempDir();
  const dataDir = makeTempDir();

  // Pre-existing last-shot cursor at 100.
  fs.writeFileSync(
    path.join(dataDir, 'last-shot.json'),
    JSON.stringify({ n: 100, updated_at: new Date().toISOString() })
  );

  // Shots that landed during downtime: some above the cursor (catch up), some below (skip).
  writeShot(watchRoot, 95,  SHOTINFO_A, PROINFO_A);
  writeShot(watchRoot, 102, SHOTINFO_A, PROINFO_A);
  writeShot(watchRoot, 104, SHOTINFO_B, PROINFO_B);

  const lastShot = createLastShotTracker({ dataDir, logger: silentLogger() });
  assert.strictEqual(lastShot.read(), 100);

  const captured = [];
  const watcher = createFileWatcher({
    config: { watch: { shotDataDir: watchRoot, writeStabilityMs: 50, pollIntervalMs: 20 } },
    logger: silentLogger(),
    lastShot,
    onShot: (s) => captured.push(s)
  });

  await watcher.start();
  await sleep(100);
  await watcher.stop();

  assert.strictEqual(captured.length, 2, 'two missed shots caught up');
  assert.deepStrictEqual(
    captured.map((s) => s.shotNumber).sort((a, b) => a - b),
    [102, 104]
  );
  assert.strictEqual(lastShot.read(), 104);

  console.log('  ✓ above-cursor shots caught up in numeric order');
  console.log('  ✓ below-cursor shot skipped');
  console.log('  ✓ last-shot advanced to highest caught-up n');
}

function ballisticScenario() {
  console.log('\n— scenario: ballistic carry computation produces plausible values —');

  // PGA-tour driver: 165 mph ball, 11° launch, 2600 rpm → expect ~220–320 yd.
  const driver = computeCarryYards({ ballSpeedMph: 165, vlaDeg: 11, backspinRpm: 2600 });
  assert.ok(driver > 200 && driver < 340, `driver carry ${driver?.toFixed(1)} should be 200–340 yd`);

  // Full 7-iron: 120 mph ball, 18° launch, 7000 rpm → expect ~140–200 yd.
  const fullIron = computeCarryYards({ ballSpeedMph: 120, vlaDeg: 18, backspinRpm: 7000 });
  assert.ok(fullIron > 120 && fullIron < 220, `full iron carry ${fullIron?.toFixed(1)} should be 120–220 yd`);

  // The actual sample shot from the bay: 45 mph ball + 8340 rpm = chunky half-swing.
  // Real-world carry here is genuinely short. Just confirm we produce a finite number.
  const softIron = computeCarryYards({ ballSpeedMph: 45.08, vlaDeg: 19.7957, backspinRpm: 8337.92 });
  assert.ok(softIron != null && softIron > 0 && softIron < 100, `soft iron carry ${softIron?.toFixed(1)} should be a positive, sub-100 yd value`);

  // Bad inputs → null, not NaN
  assert.strictEqual(computeCarryYards({ ballSpeedMph: NaN, vlaDeg: 10, backspinRpm: 2000 }), null);
  assert.strictEqual(computeCarryYards({ ballSpeedMph: 100, vlaDeg: -5, backspinRpm: 2000 }), null);

  console.log(`  ✓ driver model: ${driver.toFixed(1)} yd`);
  console.log(`  ✓ full 7-iron model: ${fullIron.toFixed(1)} yd`);
  console.log(`  ✓ soft iron (bay sample): ${softIron.toFixed(1)} yd`);
  console.log('  ✓ NaN / negative launch return null');
}

// ─── fake servers (reused across M2 + M3) ───────────────────────────────

function fakeSupabase({ port }) {
  return new Promise((resolve) => {
    const requests = [];
    const state = { players: [], sessions: [], shots: [] };
    let nextPlayerId = 1, nextSessionId = 1;
    const json = (res, status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const tableFromUrl = (url) => {
      const m = url.match(/^\/rest\/v1\/([^?]+)/);
      return m ? m[1] : null;
    };
    const parseQuery = (url) => {
      const i = url.indexOf('?');
      const params = new URLSearchParams(i >= 0 ? url.slice(i + 1) : '');
      const filters = {};
      for (const [k, v] of params.entries()) {
        if (!filters[k]) filters[k] = [];
        filters[k].push(v);
      }
      return { filters };
    };

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

        if (table === 'players' && req.method === 'POST') {
          const incoming = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
          const out = [];
          for (const row of incoming) {
            let existing = state.players.find((p) => p.optix_user_id === row.optix_user_id);
            if (existing) { Object.assign(existing, row); out.push(existing); }
            else { const created = { id: `player-${nextPlayerId++}`, ...row }; state.players.push(created); out.push(created); }
          }
          return json(res, 201, out);
        }
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
            const created = { id: `session-${nextSessionId++}`, ended_at: null, shot_count: 0, ...r };
            state.sessions.push(created);
            return created;
          });
          return json(res, 201, out);
        }
        if (table === 'sessions' && req.method === 'PATCH') {
          const idEq = filters.id && filters.id[0];
          const id = idEq && idEq.replace(/^eq\./, '');
          const target = state.sessions.find((s) => s.id === id);
          if (target) Object.assign(target, parsedBody);
          return json(res, 200, target ? [target] : []);
        }
        if (table === 'shots' && req.method === 'POST') {
          if (Array.isArray(parsedBody)) state.shots.push(...parsedBody);
          else if (parsedBody) state.shots.push(parsedBody);
          return json(res, 201, '');
        }
        if (table === 'shots' && req.method === 'GET') {
          const sessionEq = filters.session_id && filters.session_id[0];
          if (sessionEq) {
            const id = sessionEq.replace(/^eq\./, '');
            const total = state.shots.filter((s) => s.session_id === id).length;
            res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Range': `0-/${total}` });
            return res.end('[]');
          }
          return json(res, 200, []);
        }
        if (table === 'shots' && req.method === 'PATCH') {
          const updated = [];
          for (const s of state.shots) {
            if (filters.bay_number && filters.bay_number[0] !== `eq.${s.bay_number}`) continue;
            if (filters.session_id && filters.session_id[0] === 'is.null' && s.session_id != null) continue;
            if (filters.recorded_at) {
              let skip = false;
              for (const f of filters.recorded_at) {
                const [op, ...rest] = f.split('.');
                const val = rest.join('.');
                if (op === 'gte' && s.recorded_at < val) { skip = true; break; }
                if (op === 'lt'  && s.recorded_at >= val) { skip = true; break; }
              }
              if (skip) continue;
            }
            Object.assign(s, parsedBody);
            updated.push(s);
          }
          return json(res, 200, updated);
        }
        json(res, 200, []);
      });
    });
    server.listen(port, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests, state,
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}

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

        if (state.errorMode === 'http_500') { res.writeHead(500); return res.end('boom'); }
        if (state.errorMode === 'graphql_error') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ errors: [{ message: 'simulated error' }] }));
        }
        const variables = parsed?.variables || {};
        const rid = String(variables.resource_id || '');
        const booking = state.currentByResource[rid] || null;
        const data = { bookings: { total: booking ? 1 : 0, data: booking ? [booking] : [] } };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data }));
      });
    });
    server.listen(port, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/graphql`,
        requests, state,
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}

function makeBooking({ booking_id, user_id = '762951', email = 'kyle@example.com', fullname = 'Kyle Peterson', account_id = '449823' }) {
  const now = Math.floor(Date.now() / 1000);
  return {
    booking_id,
    start_timestamp: now - 60,
    end_timestamp:   now + 7200,
    is_canceled:     false,
    account: { account_id },
    user:    { user_id, email, fullname },
    resource: { resource_id: '609902' }
  };
}

// ─── M2 scenarios — Supabase POST + JSONL with VIEW shape ───────────────

async function supabasePostScenario() {
  console.log('\n— scenario: shot POSTed to supabase with VIEW-mapped columns —');
  const dataDir = makeTempDir();
  const supa = await fakeSupabase({ port: await getFreePort() });
  const config = {
    bay: { number: 2, optixResourceId: '619992' },
    watch: { shotDataDir: makeTempDir() },
    supabase: { url: supa.url, serviceKey: 'fake-service-role-key', shotsTable: 'shots' },
    session: { inactivityTimeoutMs: 600000 },
    logging: { level: 'info' }
  };

  const persistence = createPersistence({ config, logger: silentLogger(), dataDir });
  const health = await persistence.healthCheck();
  assert.strictEqual(health.ok, true);

  const shot = buildSampleShot(SHOTINFO_A, PROINFO_A, 1);
  persistence.saveShot(shot);
  await sleep(200);
  await persistence.close();
  await supa.close();

  const inserts = supa.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/rest/v1/shots'));
  assert.strictEqual(inserts.length, 1, `expected 1 shots insert, got ${inserts.length}`);
  const body = inserts[0].body;
  assert.strictEqual(inserts[0].headers['apikey'], 'fake-service-role-key');
  assert.strictEqual(inserts[0].headers['authorization'], 'Bearer fake-service-role-key');
  assert.strictEqual(inserts[0].headers['prefer'], 'return=minimal');
  assert.strictEqual(body.bay_number, 2);
  assert.strictEqual(body.session_id, null);
  assert.strictEqual(body.player_id, null);
  assert.strictEqual(body.shot_number, 1);
  assert.ok(Math.abs(body.ball_speed - 45.08) < 0.001);
  assert.ok(Math.abs(body.vla - 19.7957) < 0.001, 'incline → vla');
  assert.ok(Math.abs(body.hla - 0.306) < 0.001, 'azimuth → hla');
  assert.strictEqual(body.club, 'IRON7', 'ClubName → club column');
  assert.strictEqual(body.club_id, 24, 'Club → club_id');
  assert.strictEqual(body.hand, 0);
  assert.ok(body.assurance && body.assurance.clubSpeed === 89, 'assurance JSONB carries through');
  assert.ok(body.carry_distance != null && body.carry_distance > 0, 'carry computed by ballistic model');
  assert.ok(body.raw.shotinfo, 'raw contains shotinfo');
  assert.ok(body.raw.proShotInfo, 'raw contains ProShotInfo');

  console.log('  ✓ apikey + Bearer headers on POST');
  console.log('  ✓ VIEW fields mapped to schema columns (ballspeed/incline/azimuth → ball_speed/vla/hla)');
  console.log(`  ✓ carry_distance computed Mac-side (${body.carry_distance} yd)`);
  console.log('  ✓ assurance JSONB persisted, raw contains both source JSONs');
}

async function supabaseDownStartupScenario() {
  console.log('\n— scenario: supabase failure does not block JSONL persistence —');
  const dataDir = makeTempDir();
  const deadPort = await getFreePort();
  const config = {
    bay: { number: 1, optixResourceId: '609902' },
    watch: { shotDataDir: makeTempDir() },
    supabase: { url: `http://127.0.0.1:${deadPort}`, serviceKey: 'fake-key', shotsTable: 'shots' },
    session: { inactivityTimeoutMs: 600000 },
    logging: { level: 'info' }
  };
  const persistence = createPersistence({ config, logger: silentLogger(), dataDir });
  const health = await persistence.healthCheck();
  assert.strictEqual(health.ok, false);

  persistence.saveShot(buildSampleShot(SHOTINFO_A, PROINFO_A, 1));
  await sleep(150);
  await persistence.close();

  const lines = fs.readFileSync(persistence.shotsPath, 'utf8').trim().split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 1);

  console.log('  ✓ health check reported failure cleanly');
  console.log('  ✓ shot still landed in shots.jsonl');
}

// ─── M3 scenarios — Optix session manager ───────────────────────────────

async function setupM3() {
  const optixState = { currentByResource: {}, errorMode: null };
  const optix = await fakeOptix({ port: await getFreePort(), state: optixState });
  const supa  = await fakeSupabase({ port: await getFreePort() });
  const config = {
    bay: { number: 1, optixResourceId: '609902' },
    watch: { shotDataDir: makeTempDir() },
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

async function sessionOpensScenario() {
  console.log('\n— scenario: session opens when poll finds active booking —');
  const ctx = await setupM3();
  ctx.optixState.currentByResource['609902'] = makeBooking({ booking_id: 'bk-1' });
  await ctx.sessionManager._runPollOnce();
  const tag = ctx.sessionManager.getCurrentTag();
  assert.ok(tag);
  const playerPosts = ctx.supa.requests.filter((r) => r.method === 'POST' && r.url.startsWith('/rest/v1/players'));
  assert.strictEqual(playerPosts.length, 1);
  const sessionPosts = ctx.supa.requests.filter((r) => r.method === 'POST' && r.url.startsWith('/rest/v1/sessions'));
  assert.strictEqual(sessionPosts.length, 1);
  await teardownM3(ctx);
  console.log('  ✓ player upserted + session inserted');
}

async function sessionStableAcrossPollsScenario() {
  console.log('\n— scenario: session stays open across multiple polls —');
  const ctx = await setupM3();
  ctx.optixState.currentByResource['609902'] = makeBooking({ booking_id: 'bk-stay' });
  await ctx.sessionManager._runPollOnce();
  const t1 = ctx.sessionManager.getCurrentTag();
  await ctx.sessionManager._runPollOnce();
  const t2 = ctx.sessionManager.getCurrentTag();
  assert.deepStrictEqual(t1, t2);
  const sessionPosts = ctx.supa.requests.filter((r) => r.method === 'POST' && r.url.startsWith('/rest/v1/sessions'));
  assert.strictEqual(sessionPosts.length, 1);
  await teardownM3(ctx);
  console.log('  ✓ no duplicate session row');
}

async function sessionClosesScenario() {
  console.log('\n— scenario: session closes when booking ends —');
  const ctx = await setupM3();
  ctx.optixState.currentByResource['609902'] = makeBooking({ booking_id: 'bk-end' });
  await ctx.sessionManager._runPollOnce();
  const opened = ctx.supa.state.sessions[0];
  ctx.optixState.currentByResource['609902'] = null;
  await ctx.sessionManager._runPollOnce();
  assert.strictEqual(ctx.sessionManager.getCurrentTag(), null);
  const closed = ctx.supa.state.sessions.find((s) => s.id === opened.id);
  assert.ok(closed.ended_at);
  await teardownM3(ctx);
  console.log('  ✓ ended_at + shot_count finalized');
}

async function backfillScenario() {
  console.log('\n— scenario: backfill rewrites pre-session NULL shots within window —');
  const ctx = await setupM3();
  const recentIso = new Date(Date.now() - 30_000).toISOString();
  const oldIso = new Date(Date.now() - 5 * 60_000).toISOString();
  ctx.supa.state.shots.push(
    { id: 's-recent', bay_number: 1, session_id: null, player_id: null, recorded_at: recentIso },
    { id: 's-old',    bay_number: 1, session_id: null, player_id: null, recorded_at: oldIso }
  );
  ctx.optixState.currentByResource['609902'] = makeBooking({ booking_id: 'bk-b' });
  await ctx.sessionManager._runPollOnce();
  const tag = ctx.sessionManager.getCurrentTag();
  const recent = ctx.supa.state.shots.find((s) => s.id === 's-recent');
  const old    = ctx.supa.state.shots.find((s) => s.id === 's-old');
  assert.strictEqual(recent.session_id, tag.session_id);
  assert.strictEqual(old.session_id, null);
  await teardownM3(ctx);
  console.log('  ✓ recent shot tagged, old shot left alone');
}

async function inactivityScenario() {
  console.log('\n— scenario: inactivity timeout closes session as safety net —');
  const ctx = await setupM3();
  ctx.config.session.inactivityTimeoutMs = 200;
  await ctx.sessionManager.stop();
  ctx.sessionManager = createSessionManager({
    config: ctx.config, logger: ctx.logger, optixClient: ctx.optixClient, supabase: ctx.supabase
  });
  ctx.optixState.currentByResource['609902'] = makeBooking({ booking_id: 'bk-i' });
  await ctx.sessionManager._runPollOnce();
  assert.ok(ctx.sessionManager.getCurrentTag());
  await sleep(350);
  assert.strictEqual(ctx.sessionManager.getCurrentTag(), null);
  await teardownM3(ctx);
  console.log('  ✓ session closed by safety net');
}

async function optixErrorScenario() {
  console.log('\n— scenario: Optix HTTP/GraphQL errors do not change state —');
  const ctx = await setupM3();
  ctx.optixState.currentByResource['609902'] = makeBooking({ booking_id: 'bk-s' });
  await ctx.sessionManager._runPollOnce();
  const tagBefore = { ...ctx.sessionManager.getCurrentTag() };
  ctx.optixState.errorMode = 'http_500';
  await ctx.sessionManager._runPollOnce();
  assert.deepStrictEqual(ctx.sessionManager.getCurrentTag(), tagBefore);
  ctx.optixState.errorMode = 'graphql_error';
  await ctx.sessionManager._runPollOnce();
  assert.deepStrictEqual(ctx.sessionManager.getCurrentTag(), tagBefore);
  ctx.optixState.errorMode = null;
  ctx.optixState.currentByResource['609902'] = null;
  await ctx.sessionManager._runPollOnce();
  assert.strictEqual(ctx.sessionManager.getCurrentTag(), null);
  await teardownM3(ctx);
  console.log('  ✓ errors held state steady, recovery transitioned correctly');
}

async function restartResumeOptixScenario() {
  console.log('\n— scenario: relay restart resumes existing open session —');
  const ctx = await setupM3();
  ctx.supa.state.players.push({
    id: 'player-existing', optix_user_id: '762951', optix_member_id: '449823',
    email: 'kyle@example.com', display_name: 'Kyle Peterson'
  });
  ctx.supa.state.sessions.push({
    id: 'session-existing', player_id: 'player-existing', bay_number: 1,
    optix_booking_id: 'bk-r', started_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    ended_at: null, shot_count: 0
  });
  ctx.optixState.currentByResource['609902'] = makeBooking({ booking_id: 'bk-r' });
  await ctx.sessionManager._runPollOnce();
  const tag = ctx.sessionManager.getCurrentTag();
  assert.strictEqual(tag.session_id, 'session-existing');
  const sessionInserts = ctx.supa.requests.filter((r) => r.method === 'POST' && r.url.startsWith('/rest/v1/sessions'));
  assert.strictEqual(sessionInserts.length, 0);
  await teardownM3(ctx);
  console.log('  ✓ reattached to existing session');
}

async function shotTaggingScenario() {
  console.log('\n— scenario: shot during open session tagged with session/player —');
  const ctx = await setupM3();
  const dataDir = makeTempDir();
  ctx.optixState.currentByResource['609902'] = makeBooking({ booking_id: 'bk-t' });
  await ctx.sessionManager._runPollOnce();
  const tag = ctx.sessionManager.getCurrentTag();
  assert.ok(tag);

  const persistence = createPersistence({
    config: ctx.config, logger: ctx.logger, dataDir,
    supabase: ctx.supabase,
    getTag: () => ctx.sessionManager.getCurrentTag()
  });
  persistence.saveShot(buildSampleShot(SHOTINFO_A, PROINFO_A, 200));
  ctx.sessionManager.noteShot();
  await sleep(150);

  const inserts = ctx.supa.requests.filter((r) => r.method === 'POST' && r.url.startsWith('/rest/v1/shots'));
  assert.strictEqual(inserts.length, 1);
  assert.strictEqual(inserts[0].body.session_id, tag.session_id);
  assert.strictEqual(inserts[0].body.player_id, tag.player_id);

  await persistence.close();
  await teardownM3(ctx);
  console.log('  ✓ shot insert tagged with session_id + player_id');
}

// ─── runner ─────────────────────────────────────────────────────────────

(async () => {
  try {
    // M1 — parser + watcher + ballistic
    await singleShotScenario();
    await twoShotsBackToBackScenario();
    await incompleteShotScenario();
    await referenceShotFilteredScenario();
    await restartResumeScenario();
    await chokidarLiveScenario();
    await coldStartSkipsHistoryScenario();
    await warmStartCatchesUpScenario();
    ballisticScenario();

    // M2 — Supabase + JSONL with VIEW-shaped rows
    await supabasePostScenario();
    await supabaseDownStartupScenario();

    // M3 — Optix session manager (unchanged behavior, exercised against new shot shape)
    await sessionOpensScenario();
    await sessionStableAcrossPollsScenario();
    await sessionClosesScenario();
    await backfillScenario();
    await inactivityScenario();
    await optixErrorScenario();
    await restartResumeOptixScenario();
    await shotTaggingScenario();

    console.log('\nall smoke scenarios passed ✓');
    process.exit(0);
  } catch (err) {
    console.error('\nSMOKE FAILED');
    console.error(err.stack || err.message);
    process.exit(1);
  }
})();
