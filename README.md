# Clubhouse VIEW Shot Relay

A Node.js service that watches Uneekor VIEW's per-shot JSON output, parses each shot, computes carry from a ballistic model, and saves it to Supabase tagged with the active Optix booking's player and session.

**Status:** M1 (file-watch + parser + ballistic) ✓, M2 (Supabase) ✓, M3 (Optix session tagging) ✓.
- Each shot fires a row to `data/shots.jsonl` (durable local backup) and to Supabase when configured.
- The relay polls Optix every 30 s for the active booking on this bay's resource. When a booking is in progress it upserts a `players` row, opens a `sessions` row, tags every shot in real time with `session_id` + `player_id`, and backfills the previous 60 s of NULL-tagged shots. Sessions close when the booking ends (poll returns nothing) or after 10 min of no shots (safety net).
- The 30-second poll lag at session start is covered by the 60-second backfill — warm-up shots get retroactively attributed.

---

## How it fits

```
Uneekor VIEW ──writes──▶  ShotData/<n>/{shotinfo.json,
                                          ProShotInfo.json,
                                          imageinfo.xml, *.jpg}
                              │
                              │  ProShotInfo.json closes last (~9 s after the JPG burst)
                              ▼
                          Relay (this app)
                              │
                              ├── append → data/shots.jsonl
                              │
                              └── insert → Supabase `shots`
                                    (with session_id + player_id when a booking is active)
```

The relay is **not in the GS Pro data path**. Uneekor → GSPconnect → GS Pro flows untouched; we just observe what VIEW writes to disk. That means there is nothing the relay can do — short of filling the disk — that affects the player's game.

### Why file-watch instead of TCP

The original design proposed MITM'ing the TCP link Uneekor → GS Pro on port 921 (per the GS Pro Connect V1 docs). Live inspection on the Bay 1 PC showed a different architecture: Uneekor's hardware speaks Uneekor-native, and a separate **GSPconnect** ("Uneekor Connect") bridge translates that to GS Pro's SimplePort on `:9050`. There is no `:921` listener at this install regardless of toggles. Watching VIEW's per-shot JSON is upstream of any of that and decoupled from any wire protocol change.

---

## One-time Supabase setup

1. Create a Supabase project at https://supabase.com (free tier).
2. Open **SQL Editor → New query**, paste [`db/schema.sql`](db/schema.sql), run it. Idempotent — re-run any time the schema changes.
3. From **Project Settings → API**, copy:
   - **Project URL** (`https://xxxxx.supabase.co`)
   - **`service_role` secret key** (NOT the `anon` key — only `service_role` bypasses RLS)

   ⚠️ The `service_role` key grants full DB access. It belongs only in `config.json` on the Bay PCs (gitignored) — never commit it, never paste it in a frontend canvas.

4. Both values go into each Bay PC's `config.json` under `supabase.url` and `supabase.serviceKey` below.

The relay tests Supabase reachability on startup and logs the result, but does NOT block startup if it fails — shots always land in `data/shots.jsonl` regardless.

---

## One-time Optix setup

The relay polls Optix's GraphQL API every 30 s. Needs an **organization token** (server-side, suffix `o`).

1. Optix admin → **Develop → your app** → copy the organization token.
2. Confirm bay resource IDs are accurate:
   - Bay 1: `609902`
   - Bay 2: `619992`
3. Token + GraphQL URL go into each Bay PC's `config.json` under `optix.orgToken` and `optix.graphqlUrl`.

Leave `optix.orgToken` empty to disable session polling — shots still save, just untagged.

### Verifying Optix end-to-end

[`scripts/verify-optix.js`](scripts/verify-optix.js) introspects the live `Query.bookings` field and runs the relay's actual current-booking query against a real resource. From the deploy directory:

```powershell
$env:OPTIX_TOKEN = "<the org token>"
node scripts/verify-optix.js 609902
```

Expected: HTTP 200, raw GraphQL data prints, `RESULT: query executed cleanly`, exit 0. See the script's docblock for failure-mode triage.

---

## One-time install (per Bay PC, Windows)

1. Install Node.js LTS from https://nodejs.org (18+).

2. Install pm2 globally and register it as a Windows service:

   ```powershell
   npm install -g pm2 pm2-windows-startup
   pm2-startup install
   ```

3. Clone this repo and install dependencies:

   ```powershell
   cd $env:USERPROFILE
   git clone https://github.com/liam580/clubhouse-relay.git
   cd clubhouse-relay
   npm install
   ```

4. Copy `config.example.json` → `config.json` and edit:

   ```powershell
   copy config.example.json config.json
   notepad config.json
   ```

   Set:
   - `bay.number` → `1` or `2`
   - `bay.optixResourceId` → `609902` (Bay 1) or `619992` (Bay 2)
   - `watch.shotDataDir` → confirm the path matches your user (default assumes `suppo`; check `C:\Users\<u>\AppData\LocalLow\Uneekor\VIEW\ShotData`)
   - `supabase.url` / `supabase.serviceKey` → from the Supabase setup
   - `optix.orgToken` → from the Optix setup

5. Start under pm2:

   ```powershell
   pm2 start ecosystem.config.js
   pm2 save
   ```

6. Reboot the PC and run `pm2 list` to confirm the service auto-restarts.

No GS Pro / Uneekor configuration is needed. The relay never touches their network paths.

---

## Day-to-day commands

```powershell
pm2 list                        # what's running
pm2 logs clubhouse-relay        # live log
pm2 logs clubhouse-relay --lines 200
pm2 restart clubhouse-relay
pm2 stop clubhouse-relay
pm2 start ecosystem.config.js
```

Shot records: `data\shots.jsonl` — one JSON object per line.

```jsonc
{
  "session_id": null,
  "player_id": null,
  "bay_number": 1,
  "shot_number": 993,
  "ball_speed": 45.08,
  "spin_axis": 1.3715,
  "total_spin": 8340.3125,
  "hla": 0.306,
  "vla": 19.7957,
  "carry_distance": 29.9,
  "club_speed": 35.1305,
  "face_to_target": 0.4227,
  "attack_angle": -7.5356,
  "path": -0.7444,
  "club": "IRON7",
  "club_id": 24,
  "hand": 0,
  "assurance": { "clubSpeed": 89, "clubPath": 85, "faceAngle": 75, "attackAngle": 1 },
  "raw": { "shotinfo": { /* … */ }, "proShotInfo": { /* … */ } },
  "recorded_at": "2026-06-10T08:48:59.482Z"
}
```

Verify a Supabase insert landed:

```sh
curl "https://YOUR-PROJECT.supabase.co/rest/v1/shots?select=*&order=recorded_at.desc&limit=5" \
  -H "apikey: YOUR_SERVICE_KEY" \
  -H "Authorization: Bearer YOUR_SERVICE_KEY"
```

---

## config.json reference

```jsonc
{
  "bay": {
    "number": 1,                          // 1 or 2 — which bay this PC is
    "optixResourceId": "609902"           // 609902 (Bay 1) or 619992 (Bay 2)
  },
  "watch": {
    "shotDataDir":      "C:\\Users\\suppo\\AppData\\LocalLow\\Uneekor\\VIEW\\ShotData",
    "writeStabilityMs": 500,              // wait this long after last write before firing
    "pollIntervalMs":   100               // chokidar internal polling
  },
  "supabase": {
    "url":         "",                    // empty → Supabase disabled, JSONL only
    "serviceKey":  "",                    // service_role key
    "shotsTable":  "shots"
  },
  "optix": {
    "graphqlUrl":     "https://api.optixapp.com/graphql",
    "orgToken":       "",                 // empty → session polling disabled
    "pollIntervalMs": 30000,
    "fetchTimeoutMs": 5000
  },
  "session": {
    "inactivityTimeoutMs": 600000,        // safety net: close after 10 min of no shots
    "backfillWindowMs":    60000          // on session open, retroactively tag NULL shots from this window
  },
  "logging": {
    "level": "info",
    "file":  "./data/relay.log"
  }
}
```

`config.json` is gitignored. Each Bay PC has its own. `config.example.json` is the committed template.

---

## Local development & smoke test

```sh
npm install
npm run smoke
```

The harness exercises every code path:

**M1 — parser + watcher + ballistic**
1. Single shot dir lands → parsed → padded-string numerics float-cast, ClubName / Club / player Name carried, assurance values converted
2. Two shots back-to-back, both ingested in numeric order, last-shot advances to highest
3. ProShotInfo.json present but shotinfo.json missing → rejected gracefully, last-shot NOT advanced so retry can succeed
4. Reference shot (`Star: true`) — VIEW's bundled pro demos — suppressed; last-shot advances past them anyway
5. Restart resume from `data/last-shot.json` — `n ≤ last-seen` skipped, new shots ingested
6. Live chokidar test — start the watcher, write a shot dir, confirm `awaitWriteFinish` delivers the parsed shot
7. Ballistic carry computation produces tour-driver-realistic numbers and returns `null` on bad inputs

**M2 — Supabase**
8. Shot POSTed to `/rest/v1/shots` with `apikey` + `Bearer` headers; VIEW fields mapped to the existing schema columns (`ballspeed`→`ball_speed`, `incline`→`vla`, `azimuth`→`hla`, `ClubName`→`club`, etc.); `carry_distance` computed Mac-side; `assurance` JSONB and both source JSONs preserved in `raw`
9. Supabase down does not block startup; shots still land in JSONL

**M3 — Optix session manager**
10. Session opens when poll finds an active booking; player upserted with Optix IDs + email + name; session row inserted
11. Session stays open across multiple polls of the same booking (no duplicate row)
12. Session closes when poll returns no booking; `ended_at` + `shot_count` finalized
13. Backfill rewrites pre-session NULL shots within the 60 s window; older NULL shots left untouched
14. Inactivity timeout closes the session as a safety net
15. Optix HTTP 500 and GraphQL errors are logged but do not change session state or crash; recovery transitions correctly
16. Restart with an active booking re-attaches to the existing open session row instead of creating a duplicate

Run the relay against a real VIEW install locally:

```sh
RELAY_CONFIG=./config.json node src/index.js
```

---

## On-site verification checklist

1. After install, take a single real shot.
2. Confirm:
   - A new numbered subdirectory appeared under `watch.shotDataDir` containing `shotinfo.json`, `ProShotInfo.json`, and JPG frames.
   - Within a couple of seconds of the ProShotInfo.json file appearing, `Get-Content data\shots.jsonl -Wait -Tail 5` shows the new shot record.
   - `pm2 logs clubhouse-relay --lines 50` shows `shot captured from VIEW` for the right `n`.
   - `data\last-shot.json` updated to that `n`.
3. Reboot the PC. Confirm `pm2 list` shows the relay running again.
4. Hit one more shot. Confirm it lands.

---

## Architecture notes

- **Fail-open is automatic.** The relay is not in the data path — Uneekor → GSPconnect → GS Pro flows untouched. There's no game-flow risk by design, unlike the original TCP MITM proposal.
- **VIEW writes two JSONs per shot.** `shotinfo.json` lands with the JPG burst (~9 s before ProShotInfo). `ProShotInfo.json` writes last and is the trigger — chokidar's `awaitWriteFinish` keeps us from racing the writer.
- **Numeric fields are space-padded strings.** Every VIEW field comes through as e.g. `"   45.0800"`. `src/view-parser.js`'s `num()` helper strips + float-casts; empty strings become `null`.
- **Reference shots are filtered.** VIEW ships with bundled "pro reference" swings under `Star: true`. They sit in the same `ShotData` namespace and would otherwise contaminate the player's stats. The parser drops them but the watcher still advances `last-shot.json` so we don't re-evaluate them on every event.
- **Lifetime counter, not session counter.** `<n>` is monotonic across reboots and players — currently in the high hundreds at Bay 1. `data/last-shot.json` persists the highest ingested `n` so a relay restart doesn't double-process anything on disk.
- **Carry distance is computed locally** (`src/ballistic.js`) because Uneekor only measures launch + spin — they leave carry to be computed by the game engine. A 2D ballistic integrator with drag + Magnus lift, calibrated to land within ~5–10% of GS Pro on full shots.
- **Persistence layer is column-stable.** The Supabase shot row uses the original column names (`hla`, `vla`, `attack_angle`, `path`, `face_to_target`) — same physical quantities, different VIEW field names. New columns: `club_id` (numeric Uneekor club code), `hand` (0/1), `assurance` (JSONB with per-measurement confidence).
- **Resume on restart.** Before inserting a new session row the manager queries `sessions WHERE bay_number = N AND optix_booking_id = X AND ended_at IS NULL`. If a row exists (relay restarted mid-booking), it attaches instead of creating a duplicate.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `data\shots.jsonl` empty after a real shot | Check `watch.shotDataDir` matches your actual Windows user. Default is `C:\Users\suppo\...`. Adjust in `config.json`. |
| Relay logs `failed to read shot dir — will retry on next event` | `shotinfo.json` or `ProShotInfo.json` was missing or malformed when the trigger fired. Usually transient — VIEW may have crashed mid-write. The next shot recovers. |
| `data\last-shot.json` not advancing | Either no shots are landing (check VIEW is configured to write to the watched dir), or every shot is `Star: true` (a reference, not a real swing). |
| Logs say `supabase health check FAILED` | Confirm `url` + `serviceKey` in `config.json`, and that `db/schema.sql` has been run. Relay will keep writing JSONL regardless. |
| Supabase insert errors with `42P01` (relation does not exist) | Run `db/schema.sql` in the Supabase SQL editor. |
| Supabase insert errors with `42501` (permission denied) | You're using the `anon` key. Use the `service_role` key. |
| `optix poll failed: HTTP 401` in pm2 logs | Org token rotated or wrong. Refresh from Optix admin → Develop → your app. |
| `session manager disabled` log on startup | `optix.orgToken` is empty. Sessions won't open; shots save with NULL tags. Fill in the token and restart. |
| Booking active in Optix but session never opens | Confirm `bay.optixResourceId` matches the actual resource (`609902` Bay 1, `619992` Bay 2). Check pm2 logs for `optix poll failed`. |
| Carry distance values look wrong | The ballistic model is calibrated for full shots; chunky / chipped swings will be approximate. The raw VIEW measurements (`ball_speed`, `vla`, `backspin`, etc.) are still recorded — re-derive offline if needed. |
| Duplicate session rows for one bay | Should be impossible — the unique partial index `uniq_sessions_open_per_bay` prevents two open sessions on the same bay. If you see this, re-run `db/schema.sql`. |
