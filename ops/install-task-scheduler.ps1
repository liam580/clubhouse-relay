# Register a per-user Task Scheduler entry that runs
# ops/pm2-resurrect-on-boot.ps1 at user logon.
#
# Idempotent — re-registers cleanly if the task already exists.
# Runs as the CURRENT USER (no admin elevation needed).

$ErrorActionPreference = 'Stop'

$taskName     = 'ClubhouseRelay-PM2-Resurrect'
$repoRoot     = Split-Path -Parent $PSScriptRoot
$bootScript   = Join-Path $repoRoot 'ops\pm2-resurrect-on-boot.ps1'
$currentUser  = "$env:USERDOMAIN\$env:USERNAME"

if (-not (Test-Path $bootScript)) {
  throw "boot script not found at $bootScript"
}

Write-Output "task name:   $taskName"
Write-Output "boot script: $bootScript"
Write-Output "run as user: $currentUser"
Write-Output ""

# Use schtasks.exe — succeeds without admin for per-user logon tasks.
# AtStartup tasks require admin and a service account; we trigger at user
# logon instead. If auto-login is configured for the bay user this is
# functionally equivalent to "starts when the PC boots."

# Use Register-ScheduledTask with ONLY the -AtLogOn trigger and default
# (current-user) principal. -AtStartup needs admin; -AtLogOn for the
# current user doesn't.

try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop } catch { }

$action  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$bootScript`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Register-ScheduledTask `
  -TaskName $taskName `
  -Description 'Resurrect PM2 + clubhouse-relay when the bay user logs on.' `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings | Out-Null

Write-Output "registered."
Write-Output ""
Get-ScheduledTask -TaskName $taskName | Format-List TaskName, State, TaskPath, @{n='ActionExecute';e={$_.Actions[0].Execute}}, @{n='ActionArgument';e={$_.Actions[0].Arguments}}
