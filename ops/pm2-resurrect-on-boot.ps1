# Run by the Task Scheduler entry that fires at user logon.
# Brings PM2 + clubhouse-relay back online from the saved dump.
# Logs each run to data/pm2-boot.log so failures are visible.

$ErrorActionPreference = 'Continue'

$repoRoot = Split-Path -Parent $PSScriptRoot
$logDir   = Join-Path $repoRoot 'data'
$logFile  = Join-Path $logDir 'pm2-boot.log'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Log($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $logFile -Value $line
}

Log "===== boot resurrect start ====="

# Locate winget-installed Node (portable extract under WinGet\Packages).
$nodeRoot = $null
$wingetPkg = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages"
if (Test-Path $wingetPkg) {
  $found = Get-ChildItem $wingetPkg -Recurse -Filter 'node.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { $nodeRoot = $found.Directory.FullName }
}
if (-not $nodeRoot) {
  Log "FATAL: could not locate node.exe under $wingetPkg. Relay will not start."
  exit 1
}
Log "node root: $nodeRoot"
$env:Path = "$nodeRoot;$env:Path"

$pm2 = Join-Path $nodeRoot 'pm2.cmd'
if (-not (Test-Path $pm2)) {
  Log "FATAL: pm2.cmd not found at $pm2. Re-run npm install -g pm2 as the bay user."
  exit 1
}

# Optional grace delay so we don't race the user-profile init that mounts
# AppData on slower boots.
Start-Sleep -Seconds 5

try {
  $output = & $pm2 resurrect 2>&1 | Out-String
  Log "pm2 resurrect output:"
  $output -split "`r?`n" | ForEach-Object { if ($_.Trim()) { Log "  $_" } }
} catch {
  Log ("pm2 resurrect threw: " + $_.Exception.Message)
}

try {
  $list = & $pm2 list 2>&1 | Out-String
  Log "pm2 list after resurrect:"
  $list -split "`r?`n" | ForEach-Object { if ($_.Trim()) { Log "  $_" } }
} catch {
  Log ("pm2 list threw: " + $_.Exception.Message)
}

Log "===== boot resurrect end ====="
