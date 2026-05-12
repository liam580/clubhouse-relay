# Clubhouse GS Pro Relay

A transparent Node.js TCP proxy that sits between the Uneekor launch monitor and GS Pro. Every shot is forwarded byte-for-byte to GS Pro (so the game continues normally) while a copy of each shot's JSON is appended to a local JSONL file **and** inserted into Supabase for the player profile.

**Status:** M1 (TCP relay + JSONL) ✓, M2 (Supabase) ✓, M3 (Optix session tagging) ✓.
- Shots write to `data/shots.jsonl` always (durable local backup) and to Supabase when configured.
- The relay polls Optix every 30s for the active booking on this bay's resource. When a booking is in progress, it upserts a `players` row, opens a `sessions` row, tags every incoming shot with `session_id` + `player_id`, and backfills the previous 60s of NULL-tagged shots. Sessions close when the booking ends (poll returns nothing) or after 10 min of no shots (safety net).
- A 30-second polling latency at session start is covered by the 60-second backfill window — early warm-up shots get retroactively attributed.

---

## How it fits

```
Uneekor ──TCP──▶ Relay (this app) ──TCP──▶ GS Pro
                       │
                       └── append → data/shots.jsonl
```

GS Pro is normally a TCP server on `127.0.0.1:921`. Two ways to wedge the relay in:

- **Option B (preferred):** point Uneekor at the relay on a custom port (e.g. 922), keep GS Pro on 921. Less risk to GS Pro.
- **Option A (fallback):** relay listens on 921, GS Pro is moved to a different port (e.g. 922).

Both options use identical relay code. Only `relay.listenPort` and `gspro.port` in `config.json` change.

---

## One-time Supabase setup

Before installing on the simulator PCs, set up the database (do this once for the whole project):

1. Create a Supabase project at https://supabase.com (free tier is fine).
2. In the Supabase dashboard, open **SQL Editor → New query**, paste the contents of [`db/schema.sql`](db/schema.sql), and run it. This creates the `players`, `sessions`, and `shots` tables with their indexes (including the unique partial index that prevents duplicate open sessions per bay) and enables RLS. Re-run any time the schema changes — every statement is `IF NOT EXISTS`.
3. From **Project Settings → API**, copy:
   - **Project URL** (looks like `https://xxxxx.supabase.co`)
   - **`service_role` secret key** (under "Project API keys" — *not* the `anon` key)

   ⚠️ The `service_role` key bypasses Row Level Security and grants full DB access. It must only live in `config.json` on the simulator PCs (already gitignored) — never commit it, never paste it in a frontend canvas.
4. Both values get pasted into each simulator PC's `config.json` under `supabase.url` and `supabase.serviceKey` in the next section.

The relay tests Supabase reachability on startup and logs the result, but **does not block startup if it fails** — shots always land in `data/shots.jsonl` regardless. You can launch the relay before Supabase is configured and fill in the keys later.

---

## One-time Optix setup

The relay polls Optix's GraphQL API every 30s to detect bookings on each bay. To authenticate it needs an **organization token** (server-side, suffix `o`).

1. Sign in to the Optix admin dashboard for the Clubhouse workspace.
2. Navigate to **Develop → your app** (the custom app for Clubhouse — `client_id` from previous integrations).
3. Copy the **organization token** (ends with `o`). Treat it like any other API secret — full server-side access to the Optix workspace.
4. Confirm both bay resource IDs are accurate:
   - Bay 1: `609902` (verified against live API — has booking history)
   - Bay 2: `619992` (verified — schema-valid; cross-check with venue admin if it should be live)
5. The token + GraphQL URL go into each simulator PC's `config.json` under `optix.orgToken` and `optix.graphqlUrl`.

If `optix.orgToken` is left empty, the session manager is disabled and shots are saved with `session_id: null` and `player_id: null` — the relay still works, just without session tagging.

---

## One-time install (per simulator PC, Windows)

1. Install Node.js LTS from https://nodejs.org (any 18+ release works).

2. Install pm2 globally and register it as a Windows service so the relay survives reboots:

   ```powershell
   npm install -g pm2 pm2-windows-startup
   pm2-startup install
   ```

3. Clone or copy this `relay/` directory onto the simulator PC, then install dependencies:

   ```powershell
   cd relay
   npm install
   ```

4. Copy `config.example.json` to `config.json` and edit it for this PC:

   ```powershell
   copy config.example.json config.json
   notepad config.json
   ```

   Set:
   - `bay.number` → `1` for Bay 1, `2` for Bay 2
   - `bay.optixResourceId` → `609902` (Bay 1) or `619992` (Bay 2)
   - `relay.listenPort` and `gspro.port` → based on whichever option (A or B) the Uneekor UI supports
   - `supabase.url` and `supabase.serviceKey` → from the Supabase setup section above (leave empty to disable Supabase writes; shots will still land in `data/shots.jsonl`)
   - `optix.orgToken` → from the Optix setup section above (leave empty to disable session polling)

5. Start the relay under pm2 and persist it across reboots:

   ```powershell
   pm2 start ecosystem.config.js
   pm2 save
   ```

6. Verify by rebooting the PC and running `pm2 list`. The relay should be back up automatically.

7. **Configure Uneekor** to point at the relay's listen port (or, in Option A, point Uneekor at 921 and reconfigure GS Pro to listen on 922 instead). Confirm in the Uneekor software UI.

---

## Day-to-day commands

```powershell
pm2 list                        # what's running
pm2 logs clubhouse-relay        # live operational log (follow)
pm2 logs clubhouse-relay --lines 200
pm2 restart clubhouse-relay
pm2 stop clubhouse-relay
pm2 start ecosystem.config.js   # if previously stopped
```

Shot records: `data\shots.jsonl` — one JSON object per line, mirroring the row shape sent to Supabase.

```jsonc
{
  "session_id": null,
  "player_id": null,
  "bay_number": 1,
  "shot_number": 13,
  "ball_speed": 147.5,
  "spin_axis": -13.2,
  "total_spin": 3250,
  "hla": 2.3,
  "vla": 14.3,
  "carry_distance": 256.5,
  "club_speed": 0,
  "attack_angle": 0,
  "face_to_target": 0,
  "path": 0,
  "club": null,
  "raw": { /* full Uneekor payload for debugging */ },
  "recorded_at": "2026-05-07T19:23:11.482Z"
}
```

Operational log mirror: `data\relay.log`.

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
  "relay": {
    "listenHost": "0.0.0.0",
    "listenPort": 921                     // port Uneekor sends to (921 for Option A, 922 for Option B)
  },
  "gspro": {
    "host": "127.0.0.1",
    "port": 922                           // port GS Pro is listening on (922 for Option A, 921 for Option B)
  },
  "supabase": {
    "url": "",                            // empty → Supabase disabled, shots go to JSONL only
    "serviceKey": "",                     // service_role key from Supabase project settings
    "shotsTable": "shots"
  },
  "optix": {
    "graphqlUrl":     "https://api.optixapp.com/graphql",
    "orgToken":       "",                 // organization token (suffix 'o') — empty disables session polling
    "pollIntervalMs": 30000,              // how often to ask Optix "any active booking on this bay?"
    "fetchTimeoutMs": 5000                // per-request timeout
  },
  "session": {
    "inactivityTimeoutMs": 600000,        // safety net: close session if no shots for 10 min
    "backfillWindowMs":    60000          // on session open, retroactively tag NULL shots from this window
  },
  "logging": {
    "level": "info",
    "file": "./data/relay.log"
  }
}
```

**Important:** `config.json` is gitignored. Each simulator PC has its own copy with bay-specific values. `config.example.json` is the committed template.

---

## Local development & smoke test

From the `relay/` directory:

```sh
npm install
npm run smoke
```

The smoke harness spins up fake GS Pro, Supabase, and Optix servers, starts the relay against a temp config, and drives every code path through 15 scenarios:

**M1 — TCP relay**
1. Single shot in one TCP write
2. Single shot split across two TCP writes (defensive parser)
3. Two shots back-to-back, newline-delimited
4. Two shots back-to-back, no separator
5. Fail-open: relay survives an unreachable GS Pro

**M2 — Supabase**
6. Shot POSTed with apikey + Bearer headers; flattened columns match BallData/ClubData
7. Supabase down does not block startup; relay listens immediately and JSONL still writes

**M3 — Optix session manager**
8. Session opens when poll finds an active booking; player upserted with optix ids + email + name; session row inserted
9. Session stays open across multiple polls of the same booking (no duplicate row)
10. Session closes when poll returns no booking; `ended_at` and `shot_count` are finalized
11. Backfill rewrites pre-session NULL shots within the 60s window; older NULL shots are left untouched
12. Inactivity timeout closes the session as a safety net even if the booking is still upstream
13. Optix HTTP 500 and GraphQL errors are logged but do not change session state or crash the process
14. Relay restart with an active booking resumes the existing open session row instead of creating a duplicate
15. Shots arriving during an open session are tagged in real time with `session_id` + `player_id`

All shot records land in a temp `shots.jsonl` and the GS Pro side receives the original bytes intact.

To run the relay against a real GS Pro locally for manual testing:

```sh
RELAY_CONFIG=./config.json node src/index.js
```

---

## On-site verification checklist (when at the simulator)

1. Open the Uneekor software. Find the GS Pro target IP/port setting. Record whether the **port** field is editable.
   - Editable → use **Option B**: set Uneekor to `127.0.0.1:922`, leave GS Pro on `921`. In `config.json`: `relay.listenPort = 922`, `gspro.port = 921`.
   - Not editable → use **Option A**: reconfigure GS Pro to listen on `922`, leave Uneekor pointing at `921`. In `config.json`: `relay.listenPort = 921`, `gspro.port = 922`.
2. Save `config.json` and `pm2 restart clubhouse-relay`.
3. Hit a ball.
4. Confirm:
   - GS Pro registers the shot and the game continues.
   - `Get-Content data\shots.jsonl -Wait -Tail 5` (PowerShell tail-follow) shows the new shot record within ~1 second.
   - `pm2 logs clubhouse-relay --lines 50` shows clean operational output, no errors.
5. **Capture a sample.** Save the first real Uneekor TCP write to a file (e.g. add a temporary `console.log(chunk.toString('utf8'))` in `relay.js`, or copy a line from `shots.jsonl`'s `raw` field). Drop it into the test suite as a regression fixture.
6. Reboot the PC. Confirm `pm2 list` shows the relay running again.

---

## Architecture notes

```
Uneekor ──TCP──▶ Relay ──TCP──▶ GS Pro
                   │
                   ├── append → data/shots.jsonl
                   │
                   ├── insert → Supabase shots (with session_id + player_id from session manager)
                   │
                   └── session manager
                          │
                          ├── poll Optix every 30s for active booking
                          ├── upsert players, insert/close sessions, backfill NULL shots
                          └── hand {session_id, player_id} tag to persistence
```

- **Fail-open invariant:** any failure in the parser, persistence, Supabase, or Optix path must NOT block the forward TCP path. Game flow is sacred. The relay's two pipes (Uneekor→GSPro, GSPro→Uneekor) only depend on raw socket bytes; everything else runs in `try` blocks with logged errors.
- **JSON framing** (`src/parser.js`) is brace-balanced with string-literal awareness. Tolerates newline-delimited, single-write, and split-across-writes deliveries.
- **Persistence** (`src/persistence.js`) writes every shot to a JSONL append-stream and (when configured) POSTs the same row to Supabase's PostgREST endpoint at `/rest/v1/shots`. Each shot consults `sessionManager.getCurrentTag()` to populate `session_id` + `player_id`.
- **Session manager** (`src/session-manager.js`) is a small state machine — `NO_SESSION ⇄ SESSION_OPEN` — driven by a 30s polling timer that calls `Query.bookings(resource_id, in_progress: true)`. On open: upsert player, insert session, backfill NULL shots from the last 60s. On close (poll returns no booking, or 10-min inactivity safety net): finalize `ended_at` + `shot_count` (counted via PostgREST `Prefer: count=exact`).
- **Resume on restart:** before inserting a new session row, the manager queries `sessions WHERE bay_number = N AND optix_booking_id = X AND ended_at IS NULL`. If a row exists (relay restarted mid-booking), it attaches to that row instead of creating a duplicate.
- **JSONL is point-in-time append.** Backfill only updates Supabase; the local JSONL keeps its original NULL values for shots that arrived before their session opened. Supabase is the canonical store; JSONL is the local debug log.
- **Optix `bookings(resource_id: ...)` takes `[ID]` not `ID`.** The query uses a `[ID]` variable type with a one-element array — the schema rejected `ID!` in live testing. Documented in `optix-client.js`.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `EADDRINUSE` on relay start | Another process is on `relay.listenPort` (often GS Pro itself if Option A and you forgot to move GS Pro to a different port) |
| Uneekor can connect but no shots reach GS Pro | `gspro.port` in `config.json` doesn't match where GS Pro is actually listening. Check GS Pro settings. |
| `ECONNREFUSED` to GS Pro in logs | GS Pro isn't running. Start GS Pro first, then `pm2 restart clubhouse-relay`. |
| `shots.jsonl` has 0 lines after a real shot | Parser didn't recognize Uneekor's framing. Capture the raw bytes (see step 5 above) and add to the test suite — the framer needs to learn that variant. |
| Game continues but pm2 keeps restarting the relay | Check `data/pm2-err.log` for stack traces. |
| Logs say `supabase health check FAILED` | Confirm the URL and service key in `config.json`, and that `db/schema.sql` has been run. The relay will keep running and writing to JSONL regardless. |
| Supabase insert errors with `42P01` (relation does not exist) | Run `db/schema.sql` in the Supabase SQL editor. |
| Supabase insert errors with `42501` (permission denied) | You're using the `anon` key. Use the `service_role` key instead. |
| `optix poll failed: HTTP 401` in pm2 logs | Org token rotated or wrong. Refresh from **Optix admin → Develop → your app**. |
| `session manager disabled` log on startup | `optix.orgToken` is empty in `config.json`. Sessions won't open; shots save with NULL tags. Fill in the token and restart. |
| Booking is active in Optix but session never opens | Confirm `bay.optixResourceId` matches the actual resource (`609902` for Bay 1, `619992` for Bay 2). Check pm2 logs for `optix poll failed`. |
| Duplicate session rows for one bay | Should be impossible — the unique partial index `uniq_sessions_open_per_bay` prevents two open sessions on the same bay. If you see this, run `db/schema.sql` to add the index. |
| Session closes mid-game | Either the booking ended in Optix, or the 10-min inactivity safety net fired. Check `data/relay.log` for `inactivity timeout` or `booking_ended`. |
