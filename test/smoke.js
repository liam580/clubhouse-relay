'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');
const assert = require('assert');

const { createPersistence } = require('../src/persistence');
const { createReassembler } = require('../src/reassembler');
const { extractEnvelope, MARKER } = require('../src/connect-log-tail');
const { envelopeToShot, deriveSpinAxis, deriveTotalSpin } = require('../src/gspro-parser');
const { createProShotInfoSideWatcher } = require('../src/proshotinfo-side-watcher');
const { createSupabaseClient } = require('../src/supabase');
const { createOptixClient } = require('../src/optix-client');
const { createSessionManager } = require('../src/session-manager');

// ─── Connect envelope fixtures ──────────────────────────────────────────
// Verbatim shape inspired by the Bay 2 capture (shot 42508). All units
// already in mph / yards / deg / rpm — that's the whole point of reading
// the post-translation log.

const HEARTBEAT_ENV = {
  DeviceID: "UNEEKOREYEXR",
  Units: "Yards",
  ShotNumber: 42507,
  APIversion: "2",
  BallData: {},
  ClubData: {},
  ShotDataOptions: { IsHeartBeat: true, ContainsBallData: false, ContainsClubData: false },
};

const SHOT_BALL_ENV = {
  DeviceID: "UNEEKOR EYEXR",
  Units: "Yards",
  ShotNumber: 42508,
  APIversion: "2",
  BallData: {
    Speed: 95.59339655410767,
    SpinAxis: 0.0,           // EYE XO2 quirk — zero here, derive from back+side
    TotalSpin: 0.0,
    BackSpin: 4521.0,
    SideSpin: -188.0,
    HLA: -2.31,
    VLA: 18.93,
    CarryDistance: 122.32721216509229,
  },
  ClubData: null,
  ShotDataOptions: { ContainsBallData: true, ContainsClubData: false, IsHeartBeat: false },
};

const SHOT_CLUB_ENV = {
  DeviceID: "UNEEKOR EYEXR",
  Units: "Yards",
  ShotNumber: 42508,
  APIversion: "2",
  BallData: null,
  ClubData: {
    Speed: 69.60,
    AngleOfAttack: -3.2,
    FaceToTarget: 2.581,
    Lie: 0.0,
    Loft: 0.0,
    Path: -6.745,
    SpeedAtImpact: 69.60,
    VerticalFaceImpact: 0.0,
    HorizontalFaceImpact: 0.0,
    ClosureRate: 0.0,
  },
  ShotDataOptions: { ContainsBallData: false, ContainsClubData: true, IsHeartBeat: false, IsSpinEstimated: true },
};

// Second shot used in some scenarios.
const SHOT2_BALL_ENV = {
  ...SHOT_BALL_ENV,
  ShotNumber: 42509,
  BallData: { ...SHOT_BALL_ENV.BallData, Speed: 112.7, CarryDistance: 155.4, BackSpin: 7000, SideSpin: -1500 },
};
const SHOT2_CLUB_ENV = {
  ...SHOT_CLUB_ENV,
  ShotNumber: 42509,
  ClubData: { ...SHOT_CLUB_ENV.ClubData, Speed: 85.4, SpeedAtImpact: 85.4 },
};

const PROSHOTINFO_A = { Name: "ClubHouse", Association: "--", Slope: "", Club: 24, ClubName: "IRON7", Star: false, Hand: 0 };
const PROSHOTINFO_REFERENCE = { Name: "S.Y.Baek", Association: "KPGA", Slope: "", Club: 7, ClubName: "WEDGE", Star: true, Hand: 0 };

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

function writeProShotInfo(root, n, proInfo) {
  const dir = path.join(root, String(n));
  fs.mkdirSync(dir, { recursive: true });
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

// ─── M1 scenarios — parser, log extractor, reassembler ──────────────────

function envelopeToShotScenario() {
  console.log('\n— scenario: envelopeToShot — direct field copy, no unit conversion —');

  const merged = { ...SHOT_BALL_ENV, BallData: SHOT_BALL_ENV.BallData, ClubData: SHOT_CLUB_ENV.ClubData };
  const shot = envelopeToShot(merged, PROSHOTINFO_A);

  // Direct copies, no conversion
  assert.strictEqual(shot.shotNumber, 42508);
  assert.ok(Math.abs(shot.ballSpeed - 95.5933) < 0.001, `ballSpeed direct copy, got ${shot.ballSpeed}`);
  assert.ok(Math.abs(shot.carryDistance - 122.3272) < 0.001, `carryDistance DIRECT from Connect, got ${shot.carryDistance}`);
  assert.ok(Math.abs(shot.clubSpeed - 69.60) < 0.001, 'clubSpeed direct copy');
  assert.strictEqual(shot.hla, -2.31);
  assert.strictEqual(shot.vla, 18.93);
  assert.strictEqual(shot.backSpin, 4521);
  assert.strictEqual(shot.sideSpin, -188);
  assert.strictEqual(shot.attackAngle, -3.2);
  assert.strictEqual(shot.clubPath, -6.745);
  assert.strictEqual(shot.faceAngle, 2.581);
  assert.strictEqual(shot.speedAtImpact, 69.60);

  // Connect emitted SpinAxis: 0 and TotalSpin: 0 — derive from back/side
  assert.ok(shot.totalSpin > 0, `totalSpin derived from backspin+sidespin, got ${shot.totalSpin}`);
  assert.ok(Math.abs(shot.totalSpin - Math.hypot(4521, -188)) < 0.01, 'totalSpin = hypot(back, side)');
  assert.ok(shot.spinAxis < 0, `spinAxis derived (negative because SideSpin negative), got ${shot.spinAxis}`);

  // ProShotInfo context attached
  assert.strictEqual(shot.playerName, 'ClubHouse');
  assert.strictEqual(shot.clubId, 24);
  assert.strictEqual(shot.clubName, 'IRON7');
  assert.strictEqual(shot.hand, 0);

  // Envelope metadata
  assert.strictEqual(shot.deviceId, 'UNEEKOR EYEXR');
  assert.strictEqual(shot.units, 'Yards');
  assert.strictEqual(shot.apiVersion, '2');

  // Raw preserved
  assert.ok(shot.raw && shot.raw.ShotNumber === 42508);

  console.log('  ✓ ballSpeed/carryDistance/clubSpeed copied verbatim (no unit conversion)');
  console.log(`  ✓ totalSpin derived from BackSpin+SideSpin: ${shot.totalSpin.toFixed(1)} rpm`);
  console.log(`  ✓ spinAxis derived: ${shot.spinAxis.toFixed(2)} deg`);
  console.log('  ✓ ProShotInfo player/club context attached');
}

function envelopeToShotWithNoContextScenario() {
  console.log('\n— scenario: envelopeToShot — no side context yet (cache empty) —');

  const merged = { ...SHOT_BALL_ENV, BallData: SHOT_BALL_ENV.BallData, ClubData: SHOT_CLUB_ENV.ClubData };
  const shot = envelopeToShot(merged, null);

  assert.strictEqual(shot.playerName, null);
  assert.strictEqual(shot.clubId, null);
  assert.strictEqual(shot.clubName, null);
  assert.strictEqual(shot.hand, null);
  // Ball + club kinematics still populated
  assert.ok(Math.abs(shot.ballSpeed - 95.5933) < 0.001);
  assert.ok(Math.abs(shot.carryDistance - 122.3272) < 0.001);

  console.log('  ✓ kinematics intact when player context is null');
}

function extractEnvelopeScenario() {
  console.log('\n— scenario: extractEnvelope — log line → envelope JSON —');

  const goodLine = '2026-06-14 23:58:51,589 [10] DEBUG VGPconnect.UneekorConForm [(null)] - {"DeviceID":"UNEEKOR EYEXR","Units":"Yards","ShotNumber":42508,"APIversion":"2","BallData":null,"ClubData":null,"ShotDataOptions":null}';
  const noMarker = '2026-06-14 23:58:51,589 [10] DEBUG something else without the device id marker';
  const malformed = '2026-06-14 23:58:51,589 [10] DEBUG VGPconnect.UneekorConForm [(null)] - {"DeviceID":"broken JSON';
  const emptyLine = '';

  const env = extractEnvelope(goodLine);
  assert.ok(env, 'good line parses');
  assert.strictEqual(env.ShotNumber, 42508);
  assert.strictEqual(env.DeviceID, 'UNEEKOR EYEXR');

  assert.strictEqual(extractEnvelope(noMarker), null);
  assert.strictEqual(extractEnvelope(malformed), null);
  assert.strictEqual(extractEnvelope(emptyLine), null);
  assert.strictEqual(extractEnvelope(null), null);

  // Marker is vendor-agnostic — works for non-Uneekor logger names too
  const fullSwingLine = '2026-06-14 23:58:51,589 [10] DEBUG VGPconnect.FullSwingConForm [(null)] - {"DeviceID":"FULLSWING-X","Units":"Yards","ShotNumber":1}';
  const env2 = extractEnvelope(fullSwingLine);
  assert.ok(env2 && env2.DeviceID === 'FULLSWING-X', 'works for FullSwing logger name');

  console.log('  ✓ valid log line → parsed envelope');
  console.log('  ✓ non-matching line → null');
  console.log('  ✓ malformed JSON after marker → null');
  console.log('  ✓ vendor-agnostic across logger names');
}

function reassemblerHappyPathScenario() {
  console.log('\n— scenario: reassembler — ball + club halves merged once —');

  const emitted = [];
  const r = createReassembler({ timeoutMs: 1000, sweepIntervalMs: 100, onShot: (m) => emitted.push(m) });

  // 4 messages per shot — DEBUG ball, INFO ball (dup), DEBUG club, INFO club (dup)
  r.feed(SHOT_BALL_ENV);
  r.feed(SHOT_BALL_ENV);  // INFO duplicate of ball half
  assert.strictEqual(emitted.length, 0, 'no emit until both halves arrive');
  r.feed(SHOT_CLUB_ENV);
  assert.strictEqual(emitted.length, 1, 'emit once both halves present');
  r.feed(SHOT_CLUB_ENV);  // INFO duplicate of club half — already emitted, no double emit
  assert.strictEqual(emitted.length, 1, 'duplicate after emit is idempotent');

  const merged = emitted[0];
  assert.ok(merged.BallData && merged.BallData.Speed === 95.59339655410767, 'ball half present');
  assert.ok(merged.ClubData && merged.ClubData.Speed === 69.60, 'club half present');
  assert.strictEqual(merged.ShotNumber, 42508);

  r.stop();
  console.log('  ✓ ball + club merged into one envelope');
  console.log('  ✓ DEBUG+INFO duplicates collapse — exactly one emit per shot');
}

function reassemblerHeartbeatScenario() {
  console.log('\n— scenario: reassembler — heartbeats skipped —');

  const emitted = [];
  const r = createReassembler({ timeoutMs: 1000, sweepIntervalMs: 100, onShot: (m) => emitted.push(m) });

  r.feed(HEARTBEAT_ENV);
  r.feed(HEARTBEAT_ENV);
  r.feed(HEARTBEAT_ENV);
  assert.strictEqual(emitted.length, 0, 'heartbeats never emit');
  assert.strictEqual(r._pending().size, 0, 'heartbeats never enter pending');

  r.stop();
  console.log('  ✓ IsHeartBeat: true envelopes ignored');
  console.log('  ✓ pending map never sees heartbeats');
}

async function reassemblerStatusPingScenario() {
  console.log('\n— scenario: reassembler — status pings (no ball + no club) skipped, no phantom —');

  // Real Connect quirk Bay 2 observed: status messages like
  // LaunchMonitorBallDetected / LaunchMonitorIsReady arrive with
  // IsHeartBeat: false but Contains*Data: false AND no Ball/Club
  // subobjects. Without the early return, the sweeper would emit them
  // as all-null phantom rows. Regression test for that.
  const statusPing = {
    DeviceID: "UNEEKOR EYEXR",
    Units: "Yards",
    ShotNumber: 99001,
    APIversion: "2",
    BallData: null,
    ClubData: null,
    ShotDataOptions: {
      ContainsBallData: false,
      ContainsClubData: false,
      IsHeartBeat: false,
      LaunchMonitorBallDetected: true,
      LaunchMonitorIsReady: false,
    },
  };

  const emitted = [];
  const r = createReassembler({ timeoutMs: 30, sweepIntervalMs: 50, onShot: (m) => emitted.push(m) });
  r.start();

  r.feed(statusPing);
  r.feed(statusPing);
  r.feed({ ...statusPing, ShotNumber: 99002 });

  assert.strictEqual(r._pending().size, 0, 'status pings never enter pending');

  // Let the sweep elapse to confirm nothing leaks out as a partial.
  await sleep(120);
  assert.strictEqual(emitted.length, 0, 'no phantom rows from status pings');

  r.stop();
  console.log('  ✓ status pings (Contains*Data both false) skipped at feed-time');
  console.log('  ✓ sweep never emits an all-null phantom');
}

async function reassemblerPartialTimeoutScenario() {
  console.log('\n— scenario: reassembler — ball-only times out and emits partial —');

  const emitted = [];
  const r = createReassembler({ timeoutMs: 100, sweepIntervalMs: 30, onShot: (m) => emitted.push(m) });
  r.start();

  r.feed(SHOT_BALL_ENV);
  assert.strictEqual(emitted.length, 0, 'no immediate emit on ball-only');
  await sleep(300);
  assert.strictEqual(emitted.length, 1, 'partial emitted after timeout');
  const merged = emitted[0];
  assert.ok(merged.BallData && merged.BallData.Speed === 95.59339655410767, 'ball data preserved in partial');
  assert.strictEqual(merged.ClubData, null, 'club data null in partial');

  r.stop();
  console.log('  ✓ partial shot emitted after timeoutMs');
  console.log('  ✓ ball data preserved, club data null');
}

function reassemblerIndependentShotsScenario() {
  console.log('\n— scenario: reassembler — multiple ShotNumbers tracked independently —');

  const emitted = [];
  const r = createReassembler({ timeoutMs: 1000, sweepIntervalMs: 100, onShot: (m) => emitted.push(m) });

  // Interleave halves of two shots
  r.feed(SHOT_BALL_ENV);
  r.feed(SHOT2_BALL_ENV);
  assert.strictEqual(emitted.length, 0);
  r.feed(SHOT_CLUB_ENV);
  assert.strictEqual(emitted.length, 1, 'first shot emits when its halves complete');
  assert.strictEqual(emitted[0].ShotNumber, 42508);
  r.feed(SHOT2_CLUB_ENV);
  assert.strictEqual(emitted.length, 2, 'second shot emits independently');
  assert.strictEqual(emitted[1].ShotNumber, 42509);

  r.stop();
  console.log('  ✓ shot 42508 and 42509 tracked independently');
  console.log('  ✓ interleaved halves still emit correctly');
}

function spinDerivationScenario() {
  console.log('\n— scenario: spin axis + total spin derivation —');

  assert.strictEqual(deriveTotalSpin(null, 100), null);
  assert.strictEqual(deriveTotalSpin(0, 0), 0);
  assert.ok(Math.abs(deriveTotalSpin(7000, -1500) - Math.hypot(7000, -1500)) < 0.001);

  assert.strictEqual(deriveSpinAxis(0, 0), null);
  assert.strictEqual(deriveSpinAxis(null, 100), null);
  // Pure backspin → axis 0
  assert.ok(Math.abs(deriveSpinAxis(5000, 0) - 0) < 0.001);
  // Pure sideSpin positive → +90deg
  assert.ok(Math.abs(deriveSpinAxis(0, 5000) - 90) < 0.001);
  // Both populated → arctan in degrees
  const axis = deriveSpinAxis(7000, -1500);
  assert.ok(axis < 0 && axis > -90, `arctan(-1500/7000) in deg should be -12.1ish, got ${axis}`);

  console.log('  ✓ totalSpin = hypot(back, side) when both present');
  console.log('  ✓ spinAxis = atan2(side, back) * 180/π in degrees');
  console.log('  ✓ null inputs propagate cleanly');
}

// ─── Side-watcher scenarios ──────────────────────────────────────────────

async function sideWatcherPreCacheScenario() {
  console.log('\n— scenario: ProShotInfo side-watcher — pre-cache from existing dir —');

  const watchRoot = makeTempDir();
  writeProShotInfo(watchRoot, 100, PROSHOTINFO_A);
  writeProShotInfo(watchRoot, 99, { Name: "OldUser", Club: 1, ClubName: "DRIVER", Star: false, Hand: 0 });

  const sw = createProShotInfoSideWatcher({
    config: { watch: { shotDataDir: watchRoot } },
    logger: silentLogger(),
    staleMs: 60000,
  });

  await sw.start();
  const cached = sw.get();
  assert.ok(cached, 'cache populated on startup');
  assert.strictEqual(cached.Name, 'ClubHouse', 'pre-cached from highest n (100)');
  assert.strictEqual(cached.ClubName, 'IRON7');

  await sw.stop();
  console.log('  ✓ on start, pre-caches from highest existing ProShotInfo');
}

async function sideWatcherUpdateScenario() {
  console.log('\n— scenario: ProShotInfo side-watcher — updates on new file event —');

  const watchRoot = makeTempDir();
  const sw = createProShotInfoSideWatcher({
    config: { watch: { shotDataDir: watchRoot } },
    logger: silentLogger(),
    staleMs: 60000,
  });

  await sw.start();
  assert.strictEqual(sw.get(), null, 'cache empty when no ProShotInfo exists yet');

  writeProShotInfo(watchRoot, 200, PROSHOTINFO_A);

  // Poll for chokidar to pick up the new file
  const start = Date.now();
  while (sw.get() == null && Date.now() - start < 2000) await sleep(50);

  const cached = sw.get();
  assert.ok(cached, 'cache populated after new file write');
  assert.strictEqual(cached.Name, 'ClubHouse');

  await sw.stop();
  console.log(`  ✓ chokidar picked up new ProShotInfo in ${Date.now() - start}ms`);
}

async function sideWatcherReferenceShotScenario() {
  console.log('\n— scenario: ProShotInfo side-watcher — Star: true demos suppressed —');

  const watchRoot = makeTempDir();
  writeProShotInfo(watchRoot, 50, PROSHOTINFO_A);  // real shot
  writeProShotInfo(watchRoot, 60, PROSHOTINFO_REFERENCE);  // demo, higher n

  const sw = createProShotInfoSideWatcher({
    config: { watch: { shotDataDir: watchRoot } },
    logger: silentLogger(),
    staleMs: 60000,
  });

  await sw.start();
  const cached = sw.get();
  assert.ok(cached, 'cache populated (from real shot 50, not demo 60)');
  assert.strictEqual(cached.Name, 'ClubHouse', 'real shot wins over demo');

  await sw.stop();
  console.log('  ✓ Star: true demo shots skipped by pre-cache scan');
}

function sideWatcherStaleScenario() {
  console.log('\n— scenario: ProShotInfo side-watcher — staleness expiry —');

  const sw = createProShotInfoSideWatcher({
    config: { watch: { shotDataDir: makeTempDir() } },
    logger: silentLogger(),
    staleMs: 1,  // immediately stale
  });

  sw._setCacheForTesting(PROSHOTINFO_A);
  // Sleep slightly so the cached timestamp is older than staleMs
  const after = Date.now() + 5;
  while (Date.now() < after) { /* spin briefly */ }
  assert.strictEqual(sw.get(), null, 'cache returns null when stale');

  console.log('  ✓ cache returns null past staleMs');
}

// ─── End-to-end: fixture log file → reassembler → shots ─────────────────

async function fixtureLogEndToEndScenario() {
  console.log('\n— scenario: end-to-end — fixture log lines → parser → reassembler → shots —');

  const logPath = path.join(__dirname, 'fixtures', 'connect-debug-sample.log');
  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);

  const emitted = [];
  // Short timeout — we want partials to sweep promptly after feed.
  const r = createReassembler({ timeoutMs: 30, sweepIntervalMs: 100, onShot: (m) => emitted.push(m) });

  let envelopesParsed = 0;
  for (const line of lines) {
    const env = extractEnvelope(line);
    if (env == null) continue;
    envelopesParsed++;
    r.feed(env);
  }

  // Let the timeout elapse, then sweep to flush partials.
  await sleep(80);
  r.sweep();
  r.stop();

  // The fixture has:
  // - 2 heartbeat envelopes (skipped by reassembler at feed-time)
  // - 4 envelopes for shot 42508 (DEBUG ball + INFO ball + DEBUG club + INFO club) → 1 emit
  // - 1 envelope for shot 42509 (DEBUG ball only) → 1 emit after sweep
  // = 7 envelopes parsed, 2 shots emitted (1 complete + 1 partial)
  assert.strictEqual(envelopesParsed, 7, `parsed ${envelopesParsed} envelopes`);
  assert.strictEqual(emitted.length, 2, `emitted ${emitted.length} shots`);

  const shot42508 = emitted.find((m) => m.ShotNumber === 42508);
  assert.ok(shot42508, 'shot 42508 emitted');
  assert.ok(shot42508.BallData && shot42508.BallData.Speed === 95.59339655410767);
  assert.ok(shot42508.ClubData && shot42508.ClubData.Speed === 69.60);

  const shot42509 = emitted.find((m) => m.ShotNumber === 42509);
  assert.ok(shot42509, 'shot 42509 emitted (partial after sweep)');
  assert.ok(shot42509.BallData && shot42509.BallData.Speed === 112.7);
  assert.strictEqual(shot42509.ClubData, null, 'shot 42509 partial — no club data');

  console.log(`  ✓ parsed ${envelopesParsed} envelopes from fixture (6 envelope lines + 2 non-matches)`);
  console.log('  ✓ shot 42508 emitted with both halves');
  console.log('  ✓ shot 42509 emitted as partial after sweep');
}

// ─── fake servers (reused) ──────────────────────────────────────────────

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
        close: () => new Promise((r) => server.close(() => r())),
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
        close: () => new Promise((r) => server.close(() => r())),
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
    resource: { resource_id: '609902' },
  };
}

function buildSampleShot() {
  const merged = { ...SHOT_BALL_ENV, BallData: SHOT_BALL_ENV.BallData, ClubData: SHOT_CLUB_ENV.ClubData };
  return envelopeToShot(merged, PROSHOTINFO_A);
}

// ─── M2 scenarios — Supabase POST + JSONL ───────────────────────────────

async function supabasePostScenario() {
  console.log('\n— scenario: shot POSTed to supabase with Connect-envelope columns —');
  const dataDir = makeTempDir();
  const supa = await fakeSupabase({ port: await getFreePort() });
  const config = {
    bay: { number: 2, optixResourceId: '619992' },
    connect: { logPath: '/dev/null' },
    watch: { shotDataDir: makeTempDir() },
    supabase: { url: supa.url, serviceKey: 'fake-service-role-key', shotsTable: 'shots' },
    session: { inactivityTimeoutMs: 600000 },
    logging: { level: 'info' },
  };

  const persistence = createPersistence({ config, logger: silentLogger(), dataDir });
  const health = await persistence.healthCheck();
  assert.strictEqual(health.ok, true);

  persistence.saveShot(buildSampleShot());
  await sleep(200);
  await persistence.close();
  await supa.close();

  const inserts = supa.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/rest/v1/shots'));
  assert.strictEqual(inserts.length, 1, `expected 1 shots insert, got ${inserts.length}`);
  const body = inserts[0].body;
  assert.strictEqual(inserts[0].headers['apikey'], 'fake-service-role-key');
  assert.strictEqual(inserts[0].headers['authorization'], 'Bearer fake-service-role-key');
  assert.strictEqual(inserts[0].headers['prefer'], 'return=minimal');

  // VIEW-shape values are GONE — these come straight from Connect
  assert.strictEqual(body.bay_number, 2);
  assert.strictEqual(body.shot_number, 42508);
  assert.ok(Math.abs(body.ball_speed - 95.5933) < 0.001, 'ball_speed direct from Connect');
  assert.ok(Math.abs(body.carry_distance - 122.3272) < 0.001, 'carry_distance direct from Connect (NOT ballistic)');
  assert.ok(Math.abs(body.club_speed - 69.60) < 0.001);
  assert.strictEqual(body.back_spin, 4521);
  assert.strictEqual(body.side_spin, -188);
  assert.strictEqual(body.speed_at_impact, 69.60);
  assert.ok(body.total_spin > 0, 'total_spin derived from back+side spins');
  assert.strictEqual(body.club, 'IRON7', 'ClubName from ProShotInfo side-watcher');
  assert.strictEqual(body.club_id, 24);
  assert.strictEqual(body.hand, 0);
  assert.ok(body.raw && body.raw.ShotNumber === 42508, 'raw envelope preserved');

  console.log('  ✓ apikey + Bearer headers on POST');
  console.log(`  ✓ ball_speed = ${body.ball_speed} mph (direct from Connect)`);
  console.log(`  ✓ carry_distance = ${body.carry_distance} yd (direct from Connect, NOT ballistic)`);
  console.log(`  ✓ back_spin + side_spin = ${body.back_spin} + ${body.side_spin} rpm (new columns)`);
  console.log(`  ✓ speed_at_impact = ${body.speed_at_impact} mph (new column)`);
}

async function supabaseDownStartupScenario() {
  console.log('\n— scenario: supabase failure does not block JSONL persistence —');
  const dataDir = makeTempDir();
  const deadPort = await getFreePort();
  const config = {
    bay: { number: 1, optixResourceId: '609902' },
    connect: { logPath: '/dev/null' },
    watch: { shotDataDir: makeTempDir() },
    supabase: { url: `http://127.0.0.1:${deadPort}`, serviceKey: 'fake-key', shotsTable: 'shots' },
    session: { inactivityTimeoutMs: 600000 },
    logging: { level: 'info' },
  };
  const persistence = createPersistence({ config, logger: silentLogger(), dataDir });
  const health = await persistence.healthCheck();
  assert.strictEqual(health.ok, false);

  persistence.saveShot(buildSampleShot());
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
    connect: { logPath: '/dev/null' },
    watch: { shotDataDir: makeTempDir() },
    supabase: { url: supa.url, serviceKey: 'fake-key', shotsTable: 'shots' },
    optix:    { graphqlUrl: optix.url, orgToken: 'fake-org-tokeno', pollIntervalMs: 60000, fetchTimeoutMs: 5000 },
    session:  { inactivityTimeoutMs: 600000, backfillWindowMs: 60000 },
    logging:  { level: 'info' },
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

async function inactivityWithActiveBookingScenario() {
  console.log('\n— scenario: inactivity timeout with booking STILL active — session stays open —');
  // Regression test for the "10-min coffee break splits one booking into two
  // sessions rows" bug. Inactivity fires, but Optix still has the booking, so
  // the session must NOT close.
  const ctx = await setupM3();
  ctx.config.session.inactivityTimeoutMs = 200;
  await ctx.sessionManager.stop();
  ctx.sessionManager = createSessionManager({
    config: ctx.config, logger: ctx.logger, optixClient: ctx.optixClient, supabase: ctx.supabase,
  });
  ctx.optixState.currentByResource['609902'] = makeBooking({ booking_id: 'bk-still-active' });
  await ctx.sessionManager._runPollOnce();
  const tagBefore = ctx.sessionManager.getCurrentTag();
  assert.ok(tagBefore, 'session opened');

  // Booking stays active through the idle window.
  await sleep(350);

  const tagAfter = ctx.sessionManager.getCurrentTag();
  assert.ok(tagAfter, 'session stays open while Optix still has the booking');
  assert.strictEqual(tagAfter.session_id, tagBefore.session_id, 'same session_id — no new row created');

  // Only one sessions row should ever have been POSTed.
  const sessionPosts = ctx.supa.requests.filter(
    (r) => r.method === 'POST' && r.url.startsWith('/rest/v1/sessions')
  );
  assert.strictEqual(sessionPosts.length, 1, 'no duplicate session row from inactivity-triggered re-poll');

  await teardownM3(ctx);
  console.log('  ✓ inactivity fired, re-polled Optix, booking still active → no close, no duplicate row');
}

async function inactivityWithEndedBookingScenario() {
  console.log('\n— scenario: inactivity timeout with booking ENDED — session closes —');
  // Safety net still works when Optix legitimately reports the booking is gone.
  const ctx = await setupM3();
  ctx.config.session.inactivityTimeoutMs = 200;
  await ctx.sessionManager.stop();
  ctx.sessionManager = createSessionManager({
    config: ctx.config, logger: ctx.logger, optixClient: ctx.optixClient, supabase: ctx.supabase,
  });
  ctx.optixState.currentByResource['609902'] = makeBooking({ booking_id: 'bk-ending' });
  await ctx.sessionManager._runPollOnce();
  assert.ok(ctx.sessionManager.getCurrentTag());

  // Booking ends before the inactivity fires.
  ctx.optixState.currentByResource['609902'] = null;

  await sleep(350);

  assert.strictEqual(
    ctx.sessionManager.getCurrentTag(),
    null,
    'session closes when inactivity-triggered poll reports booking gone'
  );

  await teardownM3(ctx);
  console.log('  ✓ booking ended + inactivity → session closed (safety net intact)');
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
    email: 'kyle@example.com', display_name: 'Kyle Peterson',
  });
  ctx.supa.state.sessions.push({
    id: 'session-existing', player_id: 'player-existing', bay_number: 1,
    optix_booking_id: 'bk-r', started_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    ended_at: null, shot_count: 0,
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
    getTag: () => ctx.sessionManager.getCurrentTag(),
  });
  persistence.saveShot(buildSampleShot());
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
    // M1 — Connect log parsing + reassembly + envelope → shot record
    envelopeToShotScenario();
    envelopeToShotWithNoContextScenario();
    extractEnvelopeScenario();
    reassemblerHappyPathScenario();
    reassemblerHeartbeatScenario();
    await reassemblerStatusPingScenario();
    await reassemblerPartialTimeoutScenario();
    reassemblerIndependentShotsScenario();
    spinDerivationScenario();
    await sideWatcherPreCacheScenario();
    await sideWatcherUpdateScenario();
    await sideWatcherReferenceShotScenario();
    sideWatcherStaleScenario();
    await fixtureLogEndToEndScenario();

    // M2 — Supabase + JSONL with Connect-shaped rows
    await supabasePostScenario();
    await supabaseDownStartupScenario();

    // M3 — Optix session manager (unchanged behavior, exercised against new shot shape)
    await sessionOpensScenario();
    await sessionStableAcrossPollsScenario();
    await sessionClosesScenario();
    await backfillScenario();
    await inactivityWithActiveBookingScenario();
    await inactivityWithEndedBookingScenario();
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
