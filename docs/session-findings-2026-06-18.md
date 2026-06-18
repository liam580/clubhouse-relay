# Bay 2 chronic-blackout investigation — session 2026-06-18

## TL;DR

Sessions on Bay 2 have been closing with `shotCount: 0` for days. **The relay code is innocent** — its `extractEnvelope`, `createReassembler`, and persistence path all work correctly. The bug is **architectural**: Uneekor VIEW stopped routing shot data through GSPconnect after the original 2026-06-15 setup, and now sends GSPro Open Connect JSON directly. The relay is tailing GSPconnect's `ConnectDebug.txt`, which is no longer in the data path — so the relay receives only heartbeat envelopes (`LaunchMonitorBallDetected: false`) and the `!containsBall && !containsClub` guard correctly drops them.

The fix is to swap the ingress source. VIEW writes the same GSPro Open Connect envelopes — with real `BallData` and `ClubData` — outbound to `%USERPROFILE%\AppData\LocalLow\Uneekor\VIEW\Player.log`, prefixed by `====>`. The existing reassembler emits **181 complete shots from a 2 MB tail of this morning's session** with zero partials. Only ~10 lines of code need to change in `src/connect-log-tail.js` (generalize MARKER + the JSON-start offset) plus a config-key rename + default path. The instrumentation commit `b4f216f` stays — it's what made the silent failure visible in the first place.

## Evidence

### 1. The relay's tail is healthy

Within 23 ms of attaching, the new `'first envelope detected after start'` instrumentation fired:

```
2026-06-18T11:26:40: {"ShotNumber":166613, "linesSeen":2, "msg":"first envelope detected after start"}
```

The `tail` library + `useWatchFile:true, fsWatchOptions:{interval:100}` is reading the file in real time on this Windows box. The "tail can't see the file" hypothesis (the briefing's primary candidate) is **dead**.

### 2. GSPconnect is emitting nothing but heartbeats

Replayed the relay's actual `extractEnvelope` + `createReassembler` against every recent `ConnectDebug.txt*` file going back 4 days. Same code path the live relay uses.

| File | mtime | envelopes | `ContainsBallData:true` | `ContainsClubData:true` | shots emitted |
|---|---|---:|---:|---:|---:|
| `ConnectDebug.txt` (live) | 2026-06-18 11:30 | 147 | **0** | **0** | 0 |
| `.1` – `.5` (rotated) | 2026-06-18 11:24 – 11:29 | 945 | **0** | **0** | 0 |
| `.2026-06-17` | 2026-06-18 06:59 | 22 | **0** | **0** | 0 |
| `.2026-06-16` | 2026-06-17 06:59 | 68 | **0** | **0** | 0 |
| `.2026-06-15` | 2026-06-16 06:59 | 80 | **0** | **0** | 0 |
| `.2026-06-14` | 2026-06-15 06:59 | 53 | **0** | **0** | 0 |
| **Total** | | **1315** | **0** | **0** | **0** |

`ConnectDebug.txt.2026-06-14.1` (from the original setup work) **did** contain real shots: verbatim `"Speed":95.59, "CarryDistance":122.32` etc. So Connect IS capable. Something changed in the Uneekor side of the stack between then and now.

### 3. Connect's heartbeats reveal the upstream state

```json
{
  "DeviceID": "UNEEKOREYEXR",
  "ShotNumber": 166872,
  "ShotDataOptions": {
    "ContainsBallData": false,
    "ContainsClubData": false,
    "LaunchMonitorIsReady": false,
    "LaunchMonitorBallDetected": false,
    "IsHeartBeat": true,
    "DisconnectLaunchMonitor": false
  }
}
```

**Every** heartbeat for the last ~600 ShotNumber slots has `LaunchMonitorIsReady:false` and `LaunchMonitorBallDetected:false`. From GSPconnect's perspective the launch monitor isn't ready and no balls are being detected.

### 4. But VIEW is producing real shots — it just routes around Connect

`VIEW.exe` PID 52664 is running. `ShotData\` is fresh:

```
3077  2026-06-18 10:53:56
3076  2026-06-18 10:53:26
3075  2026-06-18 10:52:52
3074  2026-06-18 10:52:32
3073  2026-06-18 10:52:13
```

`Player.log` tail:

```
<====  {"Code":201,"Message":"GSPro Player Information","Player":{"Handed":"RH","Club":"GW","DistanceToTarget":104.5,"Surface":"Fairway"}}
<====  {"Code":202,"Message":"GSPro ready","Player":null}
proShotInfo: {"Name":"ClubHouse","Club":27,"ClubName":"WEDGE_GAP",...}
CurrentShotDataForder : C:/Users/suppo/AppData/LocalLow/UNEEKOR/VIEW/ShotData/3077/
LauncherControl.SensorType = EYEXR
SHOT END. NOW RESTARTING. SHOT ID = 3077
```

The `<====` is **incoming** from GSPro. Codes 201 / 202 are GSPro's own Open Connect response codes (the doc lists 200 = shot received, 201 = player info, 5XX = failure). So VIEW is in a **two-way GSPro Open Connect conversation** without involving GSPconnect. And it logs every outbound envelope it sends with the `====>` prefix:

```
====>  {"DeviceID":"UNEEKOR EYEXR","Units":"Yards","ShotNumber":163920,"APIversion":"2",
       "BallData":{"Speed":124.866, "BackSpin":3875, "SideSpin":-2827, "HLA":1.386,
                   "VLA":16.351, "CarryDistance":172.817},
       "ClubData":{"Speed":94.464, "FaceToTarget":0.434, ...}}
```

**Identical GSPro Open Connect schema, mph + yards, `CarryDistance` pre-computed.** Same shape the relay was already designed to consume.

### 5. The replay validates that the existing reassembler handles VIEW's format perfectly

Pointed `createReassembler` at the last 2 MB of `Player.log`:

```
total envelopes:  362
ball+club:        181   ← complete shots in one envelope
neither:          181   ← LM-status messages, correctly dropped by !containsBall && !containsClub guard
emittedShots:     181
reassembler stats: { emitted: 181, partials: 0, pending: 0 }
```

Realistic morning-session numbers in the first 3:

```
ShotNumber=152176  Speed=60.57  Carry=62.28  ClubSpeed=58.52  BackSpin=6318  SideSpin=1277
ShotNumber=152196  Speed=45.50  Carry=36.84  ClubSpeed=51.07  BackSpin=5517  SideSpin=1875
ShotNumber=152212  Speed=33.18  Carry=22.26  ClubSpeed=45.94  BackSpin=3365  SideSpin=1061
```

Different from Connect's 4-message DEBUG+INFO fan-out: VIEW emits **one envelope per shot** with both BallData AND ClubData together. The reassembler handles this transparently — when both halves arrive in a single `feed()` call, `emit()` fires immediately.

### 6. Full Player.log shape

| Metric | Value |
|---|---:|
| File size | 15,096,121 B (15 MB) |
| Process restart (file last opened) | 2026-06-16 13:48 |
| Days of accumulation | ~2 |
| Total `====>` outbound envelopes | 2,619 |
| Of which carry real `BallData` | **1,310** |
| Sibling rotation pressure | `Player-prev.log` is from 2026-06-16 13:47 (rotates only on VIEW restart) |

Compare to ConnectDebug.txt's 80-second / 10 MB rollover. Player.log is the **friendlier** ingress.

## Recommended fix

Two viable paths.

### Path A — switch the ingress (recommended)

**Change**:
- `src/connect-log-tail.js`: generalize `MARKER` + the JSON-start offset. Currently uses `slice(idx + 2)` to strip `- `, which won't work for VIEW's `====>  {`. Cleanest: after finding MARKER, scan forward for the first `{` and slice from there. Backward-compatible with the existing Connect format.
- `config.example.json`: rename `connect.logPath` → `ingress.logPath` (or keep alias) and default to `%USERPROFILE%\\AppData\\LocalLow\\Uneekor\\VIEW\\Player.log`. Add `ingress.marker` config defaulting to `====>`.
- `src/index.js`: rename log line `"starting Connect log tail"` → `"starting shot log tail"`.
- `test/fixtures/`: add a `view-player-sample.log` fixture with a handful of `====>` envelopes including BallData. Update smoke test.

**Why path A is preferred**:
1. Reliable — the data source we can directly observe and verify is producing the right format.
2. Single stable file — no aggressive log rotation to fight.
3. Lower latency — VIEW logs the envelope at the moment it sends it (no 4-message DEBUG+INFO fan-out + 300-450ms reassembly window).
4. Reassembler / persistence / Optix session manager all unchanged.
5. Forward compatible — if Uneekor reverts to routing through Connect, the marker-scanning extractEnvelope still works on the original format.

**Risks**:
- VIEW's `Player.log` encoding has historically been UTF-8 with occasional cp949 noise lines in the swing-analyzer subsystem; encoding noise outside the JSON section won't affect parsing (Lines that don't contain MARKER are skipped).
- Player.log rotates on VIEW restart. Need cursor persistence so we don't replay 15 MB of historical envelopes on every relay restart. The instrumentation's existing `linesSeen` counter is fine for visibility; a `cursor.json` byte-offset file (or just `fromBeginning:false` like today) handles the replay-prevention.

### Path B — restore the original Connect routing

Figure out why VIEW changed from sending to `Connect:1250` (LM input port, was the route in the 2026-06-15 setup) to sending directly via the `:59002` control channel. Likely cause is a config or version change in either VIEW or Uneekor Launcher between 06-15 and 06-18. Could be:

- An Uneekor Launcher setting under HKCU\Software\Uneekor\Launcher (we already saw `Setting_Software_ThirdParty_WithView_GSPro = 1` is correct).
- A VIEW preference (LauncherControl.SensorType is `EYEXR`, suggesting a different SDK code path).
- An Uneekor / GSPro / VIEW version drift since the original setup.

**Not recommended**: fragile (depends on upstream Uneekor configuration we don't control), unobservable (no log lines explaining the routing choice), and may regress on the next Uneekor / VIEW update. Also, even if we restore Connect-side routing, Path A's ingress would still work, so it's worth shipping anyway as the resilient default.

## Proposed next steps

1. **Push fix on `claude/cool-carson-p9hy83-view-ingress`** (branched off `claude/cool-carson-p9hy83` to preserve the instrumentation). Implements Path A. Smoke test passes locally against a Player.log fixture.
2. **Bay 2 deploy**: `git pull && pm2 restart`, hit one fresh shot, confirm `'shot saved'` instrumentation fires within ~1 s of impact.
3. **Bay 1 deploy** once Bay 2 is verified.
4. **Open ticket / log a question to Uneekor** about why VIEW changed its routing, in case there's a one-setting fix that restores the original architecture — useful as a fallback ingress.

## Repro / inspection scripts left in place

Under `scripts/` (gitignored if you'd rather; these are diagnostic, not production):

- `scripts/inspect-connect-log.js` — classifies envelope vs heartbeat counts across all `ConnectDebug.txt*` files.
- `scripts/replay-connect-log.js` — feeds files through `extractEnvelope` + `createReassembler` and reports emitted shots.
- `scripts/dump-one-heartbeat.js` — pretty-prints first + last envelope so the ShotDataOptions flags are readable.
- `scripts/diagnose-view-direct.js` — scans VIEW's Player.log for the outbound shot stream.
- `scripts/replay-view-log.js` — feeds Player.log through `createReassembler` to validate the Path A fix offline.

Together they can be repointed at any future log file to repeat the diagnostic in seconds.
