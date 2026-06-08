# Session handoff — Clubhouse / GS Pro / Optix relay

**For:** a fresh Claude Code session, likely on the **Bay 1 Windows PC**.
**From:** prior session on Liam's Mac, 2026-06-08.
**Mission:** verify M3 (Optix session wiring) against live Optix, then move on to M4 (stats canvas).

---

## TL;DR — current state

- **M1** (TCP relay Uneekor → GS Pro, JSONL persistence) ✓ — smoke-tested
- **M2** (Supabase shot persistence) ✓ — smoke-tested
- **M3** (Optix session wiring: poll → open/close sessions, player upsert, 60s backfill, 10-min inactivity net, restart-resume) — code complete and smoke-tested **against a mock Optix server**. NOT yet verified against live Optix.
- **M4** (stats canvas in the Clubhouse Optix app) — not started.

All M1+M2+M3 code lives in this repo (`liam580/clubhouse-relay`). `npm run smoke` passes 15/15 scenarios. The open question is whether the assumed Optix GraphQL auth + query shape actually match what live Optix expects.

---

## What's unverified about M3

The relay assumes two things that have NOT been confirmed against live Optix:

1. **Auth model:** a static "organization token" Bearer (`Authorization: Bearer <token>` where the token ends in `o`). Sourced from Optix admin → Develop → your app → organization token.
2. **Query shape:** `Query.bookings(resource_id: [ID], in_progress: Boolean, include_approved: Boolean, include_new: Boolean, limit: Int)` returning `{ total, data: [{ booking_id, start_timestamp, end_timestamp, is_canceled, account{account_id}, user{user_id, email, fullname}, resource{resource_id} }] }`. Note the `[ID]` list arg type — not `ID!`. A code comment in `src/optix-client.js` claims the schema rejected the singular type, but that claim isn't backed by a logged live call.

⚠️ The project `README.md`'s "Architecture notes" section says these were "verified against live API" — that wording is an **overclaim from a prior session**. Liam is aware. Don't re-take it as ground truth.

The same `CurrentBooking` query (byte-identical) also lives in the separate booking-app repo at `~/clubhouse/apps/occupancy-monitor/src/server.js` — but that app hasn't been started locally yet either (no `.env` exists for it). So two codebases agree on the shape, but neither has logged evidence it works against live Optix.

---

## How to verify — two parallel threads

### Thread A — Uneekor port check (physical UI at the Bay 1 PC)

Decides Option A vs Option B for relay wiring.

Open the Uneekor View/Refine software on the Bay 1 PC. Find the GS Pro target IP/port setting. Likely labels: **"Other Software"**, **"External Display"**, or under a third-party software config section — NOT a top-level "GS Pro" or "Network" panel.

- **Port is editable** → **Option B (preferred)**: change Uneekor's target port from `921` to `922`. Leave GS Pro untouched on `921`. `config.json` then has `relay.listenPort: 922`, `gspro.port: 921`. The current committed `config.example.json` is already set up for Option B.
- **Port NOT editable** → **Option A**: reconfigure GS Pro to listen on `922` instead, leave Uneekor pointing at `921`. `config.json` then has `relay.listenPort: 921`, `gspro.port: 922`.

If the UI is opaque, ground-truth from PowerShell (with both Uneekor and GS Pro running):

```powershell
# Who's actually listening on 921 and connecting to it
netstat -ano | Select-String 921

# Find the Uneekor exe + install path
Get-Process | Where-Object { $_.ProcessName -match 'uneekor|refine|view' } | Format-List ProcessName, Path

# Browse the install dir for config files (often C:\Program Files\Uneekor\ or %APPDATA%\Uneekor\)
# Look for *.json, *.ini, *.config, appsettings*
```

### Thread B — live Optix verification (`scripts/verify-optix.js`)

This script (already committed to this branch's parent `main`) introspects the real `Query.bookings` field (settles `[ID]` vs `ID!` and exact arg names) and runs the relay's exact `CURRENT_BOOKING_QUERY` against a real resource ID.

In the `clubhouse-relay` directory on the Bay 1 PC:

```powershell
$env:OPTIX_TOKEN="<the org token>"
node scripts/verify-optix.js 609902
```

Expected: HTTP 200, raw GraphQL data prints, "RESULT: query executed cleanly", exit 0.

Failure modes:
- **HTTP 401** → token wrong or rotated. Pull a fresh one from Optix admin → Develop → your app.
- **GraphQL "Unknown argument 'resource_id'"** → the assumed arg name is wrong. The introspection block at the top of the script's output will list the real args + types — use those.
- **`[ID]` rejected, expects `ID!`** → flip the query variable type in `src/optix-client.js` (and in `apps/occupancy-monitor/src/server.js` on the booking-app side).

When verify-optix.js prints "RESULT: query executed cleanly", both unknowns are resolved and M3 is genuinely done.

---

## Where everything lives

| Thing | Location |
|---|---|
| This deploy repo (Bay 1 PC checkout) | `C:\Users\<you>\clubhouse-relay\` after `git clone https://github.com/liam580/clubhouse-relay` |
| Liam's dev working copy of the relay (Mac) | `~/Documents/Documents - Liam's MacBook Air/Claude/Projects/clubhouse/relay/` — non-git scratch dir |
| Integration brief | Same Mac dir, file `gspro-profile-integration-brief.md` |
| Optix context doc (canvas + booking mutation patterns) | `~/Desktop/Desktop - Liam's MacBook Air/optixcontext.txt` (Mac only) |
| Booking app (**SEPARATE PROJECT — DO NOT TOUCH**) | `~/clubhouse` (Mac). Different scope. Its `apps/occupancy-monitor/` reuses the same Optix queries but is owned by a different session. |

Note the macOS migration folder gotcha: paths under `~/Documents/Documents - Liam's MacBook Air/` exist because of an older Mac migration. The "obvious" path `~/Documents/Claude/Projects/clubhouse/` does NOT exist. Always disambiguate before assuming.

---

## Secrets — fetch, don't ask

**Never commit the org token to this repo.** It belongs only in `config.json` (gitignored) on each Bay PC, and in `apps/occupancy-monitor/.env` (gitignored) for the booking app. Pull it from:

1. **Canonical:** Optix admin → Develop → your app → organization token (ends in `o`)
2. **Already on the Bay 1 PC** if previously configured: `config.json` under `optix.orgToken`
3. **Liam's password manager / prior chat paste** if accessible

Safe to reference inline (already in code, not secret):

- Optix `client_id`: `e50412bbbbeb3ca3e19158663b6651248a50ba4f` — only used in client-side canvas/embed contexts
- Bay 1 resource ID: `609902` — verified to exist (has booking history per prior CSV exports)
- Bay 2 resource ID: `619992` — schema-valid; cross-check with Liam if it should be live

Supabase project URL and `service_role` key live only in `config.json` on the Bay 1 PC (gitignored), and in the matching Supabase admin dashboard. If you need them, pull from `config.json` directly or from Liam — don't paste them into anything that ends up tracked in git.

---

## What to report back at session end

When you finish a chunk, summarize for the next handoff:

- **Uneekor:** port editable Y/N? Current target IP + port in the UI? Any `netstat` / install-dir findings?
- **verify-optix.js:** did the live run succeed? If errors — paste the exact output from both the introspection block and the query block.
- **Code changes:** anything modified in `src/optix-client.js` or elsewhere? Any new commits?
- **Bay 1 `config.json`:** any field changes? (Don't paste the token value.)
- **What's next:** if both threads succeed → M3 is verified, ready for M4. If either fails → what's still blocking?

Update this doc in place on this branch if helpful, or write a follow-up `docs/session-handoff-N.md`.

---

## What comes after M3 verified

**M4 — stats canvas.** A small HTML page hosted on GitHub Pages or Netlify, embedded inside the Clubhouse Optix app via a `MOBILE_HOME_SECTION_ITEM` canvas. Reads `?user_id={user_id}&token={token}` from URL macros. Queries Supabase for that player's shot history and shows career stats + per-session breakdown.

Pattern reference: the prior Neighbor Pass canvas at `https://liam580.github.io/Neighbor-Pass/neighbor-banner.html?token={token}`. Uses token-Bearer fetch to `https://api.optixapp.com/graphql` from inside the canvas page.

Brand: dark green `#0d2618`, cream `#ede4cf`, Tusker Grotesk headlines.

The relay project's working dir has a partial stats canvas at `canvas/stats.html` + `canvas/edge-functions/stats/index.ts` that's a useful starting point but lives in the non-git Mac scratch dir, not this repo.

---

## Tooling tips for a fresh Claude Code session here

- The integration brief is the single source of truth for product goals. Have Claude read it first if it's available locally — otherwise the TL;DR above is enough.
- For any "where does X live" question on the Mac side, search both `~/Documents/Documents - Liam's MacBook Air/` AND `~/Desktop/Desktop - Liam's MacBook Air/` — both are migration folders that contain real project files.
- The `~/clubhouse` repo on the Mac is a completely separate booking-app project. Read-only at most; never modify.
- This repo's smoke suite (`npm run smoke`) is fast (~5s) and exhaustive of M1+M2+M3 logic against mocks. Run it after any code change.
