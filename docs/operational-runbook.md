# Clubhouse relay — operational runbook

Bay PCs power on and off constantly. This document covers what survives those cycles, what doesn't, and how to recover when something is off.

## The relay's life cycle and what survives what

| Event | What happens to the relay | Recovery |
|---|---|---|
| Relay process crashes | PM2 autorestarts within ~1s (max_restarts=10, min_uptime=30s) | Automatic |
| Relay throws an uncaught exception | Same — PM2 autorestart | Automatic |
| `pm2 stop` / `pm2 restart` | PM2 manages the transition | Automatic |
| Windows reboot, user logs in | Task Scheduler entry `ClubhouseRelay-PM2-Resurrect` fires `pm2 resurrect` at logon, which spawns the relay from `~/.pm2/dump.pm2` | Automatic (if the task is registered and the user logs in) |
| Windows reboot, NO user logs in | Nothing runs the relay | Manual — log in, or enable auto-login (see below) |
| VIEW restart (Player.log rotates to Player-prev.log + new Player.log) | The `tail` library detects the size shrink and resets the cursor. If the brief missing-file window emits an error, the relay auto-reattaches after 5s (exponential backoff up to 60s) | Automatic |
| GSPro restart | Doesn't affect the relay's data flow — relay tails VIEW's log, not GSPro's | Automatic |
| GSPconnect restart | Same — relay doesn't tail GSPconnect anymore (see `session-findings-2026-06-18.md`) | Automatic |
| Supabase dashboard unavailable | Shots still land in `data/shots.jsonl`; Supabase POSTs log a `supabase insertShot failed` warning. When Supabase comes back, future shots resume inserting | Automatic — older shots stay in JSONL only (a backfill script could re-POST them; not built yet) |
| Optix booking ends | Session closes cleanly via the inactivity / poll watchdog. Subsequent shots tag with `session_id: null` until the next booking starts | Automatic |

## The Task Scheduler trigger (the thing the chronic blackout was about)

A scheduled task named `ClubhouseRelay-PM2-Resurrect` runs at user logon. It runs `ops/pm2-resurrect-on-boot.ps1` which:

1. Locates the winget-installed Node under `%LOCALAPPDATA%\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_…\node-vX.Y.Z-win-x64\`.
2. Calls `pm2 resurrect`, which reads `~/.pm2/dump.pm2` and re-spawns any saved processes that aren't already running.
3. Logs everything to `data/pm2-boot.log` so failures are visible.

**It only fires at user logon, not at system startup** — `-AtStartup` requires admin, which the bay user doesn't have. If the bay PC powers on and is left at the lock screen, nothing happens. Two ways to close that gap:

- **Enable Windows auto-login for the bay user.** `netplwiz` → uncheck "Users must enter a user name and password to use this computer" → enter the bay user's password. Once auto-login is on, boot → automatic logon → Task Scheduler fires → relay comes back up. This is the simplest path for kiosk-style bay PCs.
- **Install PM2 as a Windows service** (via `pm2-installer` or `nssm`). Survives any reboot regardless of user login state, but requires admin to install. See `pm2-installer` on GitHub for the standard approach.

### Verify the task is registered

```powershell
Get-ScheduledTask -TaskName 'ClubhouseRelay-PM2-Resurrect' | Format-List TaskName, State, @{n='Action';e={$_.Actions[0].Execute + ' ' + $_.Actions[0].Arguments}}
Get-ScheduledTaskInfo -TaskName 'ClubhouseRelay-PM2-Resurrect' | Format-List LastRunTime, LastTaskResult, NextRunTime
```

`State: Ready` + `LastTaskResult: 0` means it's wired and the last run succeeded. `LastTaskResult: 1` means the boot script crashed — check `data/pm2-boot.log`.

### Re-register the task if it's missing

```powershell
& 'C:\Users\suppo\clubhouse-relay\ops\install-task-scheduler.ps1'
```

Idempotent — replaces any existing version cleanly.

### Test the task without rebooting

```powershell
Start-ScheduledTask -TaskName 'ClubhouseRelay-PM2-Resurrect'
Start-Sleep -Seconds 10
Get-Content C:\Users\suppo\clubhouse-relay\data\pm2-boot.log -Tail 20
```

The log should show `pm2 resurrect output:` followed by either "Restoring processes" (cold start) or the relay already running (no-op). If you see "FATAL" lines, the script can't find Node or PM2 — re-run `npm install -g pm2` as the bay user.

## Verifying the relay is running and healthy

The single most important sanity check:

```powershell
$pm2 = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.16.0-win-x64\pm2.cmd"
& $pm2 list
```

`clubhouse-relay` should be `online` with a multi-minute uptime. If status is `errored`, look at the recent logs:

```powershell
& $pm2 logs clubhouse-relay --lines 50 --nostream
```

The startup signature for a healthy relay looks like this:

```
{shotLog: "...\Player.log", supabase: "enabled", optix: "enabled", msg: "starting clubhouse-relay"}
{msg: "ProShotInfo side-watcher ready", preCached: true, preCachedName: "<player>"}
{logPath: "...\Player.log", fromBeginning: false, msg: "starting shot log tail"}
{msg: "shot log tail attached"}
{bay: 2, resourceId: "...", msg: "session manager starting"}
{status: 200, msg: "supabase health check passed"}
```

Every 5 minutes, a `shot log tail heartbeat` line should fire showing `linesSeen` and `envelopesEmitted` ticking up. If `envelopesEmitted` stays at 0 for several minutes while VIEW is actively in use, something is wrong upstream — see "Diagnosing zero shots" below.

## Diagnosing zero shots

Use this decision tree:

1. **Is the relay running?** `pm2 list` → `clubhouse-relay` is `online`. If not → check `pm2-err.log`, `pm2-boot.log`. Run `pm2 start ecosystem.config.js` or `pm2 resurrect` to bring it back.

2. **Is VIEW running?** `Get-Process VIEW` should return a process. If not, VIEW isn't capturing shots regardless of relay state. Launch from Uneekor Launcher.

3. **Is Player.log being written?** `Get-Item C:\Users\suppo\AppData\LocalLow\Uneekor\VIEW\Player.log` — `LastWriteTime` should be within the last few seconds during active play. If stale, VIEW is running but idle / disconnected from the LM.

4. **Is the relay seeing Player.log lines?** Look at the most recent `shot log tail heartbeat` in pm2 logs. `linesSeen` should be increasing between heartbeats; `envelopesEmitted` should be increasing when shots are hit. If `linesSeen` stays at 0, the tail isn't reading — either the file path is wrong in `config.json`, or there's a permission issue.

5. **Are envelopes being emitted but no shots saved?** Look for `'first envelope detected after start'` (one-time line) and `'reassembler emit'` and `'shot saved'` lines. If you see emitted envelopes but no `'shot saved'`, the persistence layer is failing — check `pm2-err.log`.

6. **Is GS Pro emitting actual ball data, or only heartbeats?** Run the offline replay against the live log file:

   ```powershell
   $node = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.16.0-win-x64\node.exe"
   & $node C:\Users\suppo\clubhouse-relay\scripts\replay-view-log.js
   ```

   Reports envelopes parsed + shots emitted from the recent tail. If it reports 0 ball-data envelopes during a window where someone played, the LM-side integration is broken — see `docs/session-findings-2026-06-18.md` for the symptom pattern (`LaunchMonitorBallDetected: false` heartbeats forever).

## Recovery cheat sheet

| Symptom | Fastest fix |
|---|---|
| Relay isn't running after a reboot | Log in as the bay user (the Task Scheduler entry fires). If still no relay, run `pm2 resurrect` manually. If `pm2` itself isn't reachable, `npm install -g pm2` + `pm2 start ecosystem.config.js`. |
| Relay running but no shots after a VIEW restart | The recovery loop should reattach within 60s. If `pm2 logs` shows `tail error — scheduling re-attach` but no subsequent `shot log tail re-attached`, do `pm2 restart clubhouse-relay`. |
| Config drift (wrong logPath / wrong secrets / wrong bay number) | Edit `config.json` directly, then `pm2 restart clubhouse-relay --update-env`. |
| Lots of `supabase insertShot failed PGRST204 "column does not exist"` | Schema migration on the Supabase project wasn't applied. Run `db/schema.sql` from the Supabase dashboard SQL editor. Shots written during the gap stayed in `data/shots.jsonl` and can be re-POSTed manually. |
| Stale Optix session never closing | Session manager polls every 30s and auto-closes when the booking ends; if it gets stuck, `pm2 restart clubhouse-relay` re-syncs from Optix. |

## Operational state survives all of this

These are durable across PC reboots, Windows updates, and relay restarts:

- `~/.pm2/dump.pm2` — PM2's saved process list (refreshed via `pm2 save` after any change).
- `~/.pm2/pm2.log` — PM2 daemon log.
- `data/shots.jsonl` — every shot the relay has ever processed (append-only).
- `data/last-shot.json` — the cursor the side-watcher uses to skip historical replay on cold start.
- `data/pm2-out.log`, `data/pm2-err.log` — pino-formatted relay logs (rotate on PM2 restart).
- `data/pm2-boot.log` — output from each Task Scheduler boot run.
- `data/relay.log` — pino's own file sink (mirrors stdout, separately tail-able).

If you ever need to start completely fresh: stop the relay (`pm2 stop clubhouse-relay`), wipe `data/`, restart. The cursor logic will skip historical Player.log content and resume tailing live.
