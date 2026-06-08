# Session handoff #2 — Bay 2 verification, mid-flight

**For:** the next Claude Code session, likely the **desktop app running locally on the Bay 2 Windows PC** (so PowerShell is directly accessible).
**From:** a Claude Code web session (Linux cloud container) on 2026-06-08. PowerShell access was indirect — the user pasted output back by hand, which got expensive once we hit large Uneekor JSON files. A local Bay 2 session can just drive PowerShell directly.
**Mission:** finish what `docs/session-handoff.md` started, with the corrections below.

---

## What's already been ruled out / confirmed

Read `docs/session-handoff.md` first for the original framing, but be aware of these material corrections from the last session:

- **The doc's `921`/`922` port numbers are wrong.** Confirmed by netstat at Bay 2: `GSPconnect.exe` (PID 58412) is listening on `0.0.0.0:1250`, not 921. Port 1250 is the documented GSPro Connect TCP API. The whole "Option A vs Option B" framing of `relay.listenPort: 921/922` and `gspro.port: 921/922` needs to be re-derived against `1250`. Once Uneekor View's actual target port is known, the relay-side config should be `gspro.port: 1250` regardless of A or B.
- **The relay is NOT deployed on Bay 2.** No `clubhouse-relay` directory exists anywhere on `C:\` on Bay 2. So there's no `config.json` here either — meaning the org token isn't on this PC at the doc's claimed location. A previous session may have set up Bay 1 only.
- **`SwingMx.dll.config` does not hold the GS Pro target.** Its `HttpHost = http://192.168.1.246:40005/` and internal `Port: 7979` are VIEW's swing-analysis service, not GSPro. The `192.168.1.x` IP is on a different subnet than this PC's `192.168.0.181` LAN — it's stale, possibly from a prior network.
- **No Refine / Refine+ app on this rig.** `C:\Uneekor\` contains only `VIEW\` and `Launcher\`. So Uneekor's GS Pro handoff lives inside VIEW.exe itself, not a separate companion app.
- **Smoke suite still passes 15/15** after `npm install` on a fresh clone. M1+M2+M3 against mocks is fine. The unverified pieces are the live-Optix questions, unchanged.

## Bay 2 environment snapshot (already confirmed)

| Thing | Value |
|---|---|
| LAN IP | `192.168.0.181` (also `172.16.1.55` on a second NIC) |
| Username | `suppo` |
| GSPro running | yes (`C:\GSProV1\Core\GSP\GSpro.exe`, PID 91360) |
| GSPconnect running | yes (`C:\GSProV1\Core\GSPC\GSPconnect.exe`, PID 58412), listening on `0.0.0.0:1250` |
| Uneekor VIEW.exe | `C:\Uneekor\VIEW\VIEW.exe` (was PID 20840 — may have been closed since) |
| Uneekor Launcher | `C:\Uneekor\Launcher\UneekorLauncher.exe`, listening on `0.0.0.0:54322` |
| AppData candidate | `C:\Users\suppo\AppData\Roaming\UneekorLauncher\` (exists, contents not yet inspected) |

## Thread A — what's still needed

The GS Pro target IP/port that Uneekor VIEW sends to is **still unknown**. The setting wasn't in `SwingMx.dll.config`. Three remaining places to look. **Open Uneekor VIEW.exe from the Launcher first** so any "live" socket also shows up.

```powershell
# (1) Dump the UneekorLauncher AppData folder — most likely place for user-level connection config
Get-ChildItem -Path "$env:APPDATA\UneekorLauncher" -File -Recurse -ErrorAction SilentlyContinue |
  Where-Object { $_.Length -lt 50000 -and $_.Name -match '\.(json|config|ini|xml|txt)$' } |
  ForEach-Object {
    Write-Host "===== $($_.FullName) =====" -ForegroundColor Cyan
    Get-Content $_.FullName -ErrorAction SilentlyContinue
  }

# (2) Look at the GSProV1 connector's own config files — GSPro may pin the accepted client IP
Get-ChildItem -Path "C:\GSProV1" -File -Recurse -ErrorAction SilentlyContinue |
  Where-Object { $_.Length -lt 50000 -and $_.Name -match '\.(json|config|ini|xml)$' } |
  Select-Object FullName, Length

# (3) Registry sweep — Uneekor often stores user settings under HKCU
Get-ChildItem -Path "HKCU:\Software" -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match 'neekor|efine|GSPro' } |
  Select-Object Name

# (4) Once VIEW is launched AND you've entered its GSPro / third-party mode, snapshot its sockets
$id = (Get-Process -Name VIEW -ErrorAction SilentlyContinue).Id
if ($id) { netstat -ano | Select-String "\s$id$" }
```

If none of (1)/(2)/(3) reveals a stored IP/port and (4) shows VIEW connecting to `127.0.0.1:1250` or `192.168.0.181:1250` once you start a round, **then the answer is just "VIEW targets `1250` — no relay reconfig needed; just set `gspro.port: 1250` and `relay.listenPort` to whatever port the next install reconfigures VIEW to use."**

Also worth a careful look in the Uneekor View GUI itself — the GS Pro setup screen should show the destination IP/port plainly, and whether it's editable. That alone settles A-vs-B.

## Thread B — what's still needed

The live `scripts/verify-optix.js` run never happened — the **Optix org token** never reached either session. The whole script is ready and the endpoint works (already verified end-to-end with unauthenticated and bogus-token requests from the cloud container; the schema is permission-scoped, so `bookings` is hidden until a real token is presented, and that produces the expected 401 path).

Two ways to get the token onto Bay 2:

1. **Optix admin → Develop → your app → organization token.** Suffix `o`. Paste it into a PowerShell env var:
   ```powershell
   $env:OPTIX_TOKEN = "<paste>"
   ```
2. **From Bay 1's `config.json`**, if Bay 1 was previously configured. Pull `optix.orgToken` out of there.

Then, once the relay is cloned onto Bay 2 (it isn't yet — see "deployment" below), run:

```powershell
cd <repo>
node scripts/verify-optix.js 619992       # Bay 2 resource ID
node scripts/verify-optix.js 609902       # cross-check against Bay 1 ID
```

Expected on success: HTTP 200, introspection block shows `resource_id: [ID]` (or `ID!` — that's the question), `RESULT: query executed cleanly`, exit 0. Failure modes are listed in the original handoff doc and the script itself.

## Deployment gap (was not on the original handoff's radar)

The original handoff assumed Bay 2 already had the relay installed. **It doesn't.** Before any of M3 verification matters for Bay 2 specifically, the next session will need to:

```powershell
cd $env:USERPROFILE
git clone https://github.com/liam580/clubhouse-relay
cd clubhouse-relay
copy config.example.json config.json
# Edit config.json: fill in optix.orgToken, supabase URL/key, relay.listenPort,
# gspro.port (likely 1250 per the finding above), bay number/resource_id (619992 for Bay 2),
# gspro.host (likely 127.0.0.1)
npm install
npm run smoke      # sanity, should pass 15/15
```

Token and Supabase creds: pull from Bay 1 or from the Optix/Supabase admin dashboards. Do not commit `config.json`.

## What to report back

Same shape as the original handoff doc asks for:

- **Uneekor (Thread A):** which of (1)/(2)/(3)/(4) revealed the target IP/port. Is the port editable in the GUI? Is the current target `1250`?
- **verify-optix.js (Thread B):** raw introspection-args output for `Query.bookings`, raw query response for resource IDs `619992` and `609902`.
- **Bay 2 deployment:** did `clubhouse-relay` get cloned and `config.json` populated? `npm run smoke` still 15/15?
- **What's blocking next:** if anything.

Either update `docs/session-handoff.md` in place or write `docs/session-handoff-3.md` — your call.

## Tips for a local-on-Bay-2 session

- You have PowerShell directly. Don't make the user paste back output.
- **Do not** `Get-ChildItem -Recurse` over `C:\Uneekor\VIEW\Pro` — those folders contain multi-MB per-shot pose-tracking JSON files (`swingtrace.json`, `left.json`, `right.json`) that will flood your context if you `Get-Content` them. Filter by `Length -lt 20000` and exclude `\\Pro\\` and `\\SCAMIMG\\` paths.
- The `optixcontext.txt` file referenced in the original doc is on the Mac, not Bay 2. Don't go looking for it here.
- The macOS migration-folder gotcha doesn't apply on Windows. Ignore that section.
