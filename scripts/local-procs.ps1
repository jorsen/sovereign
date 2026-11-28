# Finds (and optionally stops) this checkout's website and Discord bot.
# Matched by command line and this folder's path, plus whatever listens on
# the website's port (3001), so another app's copies -- e.g. Capital
# Records on port 3000 -- are never touched.
#
#   powershell -File scripts\local-procs.ps1 -Check website   # exit 0 if running
#   powershell -File scripts\local-procs.ps1 -Check bot
#   powershell -File scripts\local-procs.ps1 -Stop            # stop both
param([string]$Check, [switch]$Stop)

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path.TrimEnd('\')
$cmds = Get-CimInstance Win32_Process -Filter "Name='cmd.exe'"

function Find-Website {
  $port = @(Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)"
  })
  # The hidden restart loop too, or it would bring the website straight back.
  @($cmds | Where-Object { $_.CommandLine -like "*$root\scripts\run-website.bat*" }) + $port | Where-Object { $_ } | Sort-Object ProcessId -Unique
}
function Find-Bot {
  # The hidden loop (run-bot.bat), or a visible start-bot.bat window.
  @($cmds | Where-Object { $_.CommandLine -like "*$root\discord-bot\start-bot.bat*" -or $_.CommandLine -like "*$root\scripts\run-bot.bat*" })
}

if ($Check -eq 'website') { if (Find-Website) { exit 0 } else { exit 1 } }
if ($Check -eq 'bot') { if (Find-Bot) { exit 0 } else { exit 1 } }

if ($Stop) {
  foreach ($pair in @(@('Website', (Find-Website)), @('Bot', (Find-Bot)))) {
    $name = $pair[0]; $procs = @($pair[1] | Where-Object { $_ })
    if (-not $procs.Count) { Write-Output "$name was not running."; continue }
    foreach ($p in $procs) { & taskkill /pid $p.ProcessId /t /f *> $null }
    Write-Output "$name stopped."
  }
}
