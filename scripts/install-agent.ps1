# Sai Agent installer.
#
# Run this on a store PC and nothing else. It fetches the agent, puts it in a fixed
# place, and starts it. There are no files to copy and no configuration to edit: the
# agent shows a code, the owner approves that code in the admin, and the agent gets
# everything else from the cloud.
#
#   irm https://raw.githubusercontent.com/vasgenerativesolutions-collab/sai-traders-admin/main/scripts/install-agent.ps1 | iex

$ErrorActionPreference = 'Stop'

$Repo    = 'https://raw.githubusercontent.com/vasgenerativesolutions-collab/sai-traders-admin/main'
$Dest    = Join-Path $env:LOCALAPPDATA 'SaiAgent'
$AgentJs = Join-Path $Dest 'sai-agent.js'

function Say($m) { Write-Host "  $m" }
function Head($m) {
  Write-Host ''
  Write-Host ('=' * 70)
  Write-Host "  $m"
  Write-Host ('=' * 70)
}

Head 'SAI AGENT - INSTALL'

# --- 1. Node -----------------------------------------------------------------
# The agent is plain Node with no dependencies, so this is the only prerequisite.
Say 'Checking for Node.js ...'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host ''
  Write-Host '  Node.js is not installed.' -ForegroundColor Yellow
  Write-Host '  Install the LTS version from https://nodejs.org then run this again.'
  Write-Host ''
  return
}
$nodeVersion = (& node --version).Trim()
$major = [int](($nodeVersion -replace '^v','') -split '\.')[0]
if ($major -lt 18) {
  Write-Host ''
  Write-Host "  Node.js $nodeVersion is too old. Version 18 or newer is required." -ForegroundColor Yellow
  Write-Host '  Update from https://nodejs.org then run this again.'
  Write-Host ''
  return
}
Say "Node.js $nodeVersion - ok"

# --- 2. Stop anything already running ----------------------------------------
# Re-running this installer must leave exactly ONE current agent running. Older
# agents do not take the single-instance lock, so they cannot be asked to stand
# down - they have to be stopped at the OS level. Skipping this is what let a
# hidden agent keep running stale code while a published fix looked broken.
Say 'Stopping any agent already running ...'
$stopped = 0
try {
  $procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop
  foreach ($p in $procs) {
    if ($p.ProcessId -eq $PID) { continue }
    $cmd = [string]$p.CommandLine
    if ($cmd -match 'sai-agent\.js' -or $cmd -match 'store_supervisor\.js' -or $cmd -match 'agent.index\.js') {
      try {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
        $stopped = $stopped + 1
      } catch {
        Say "  could not stop process $($p.ProcessId): $($_.Exception.Message)"
      }
    }
  }
} catch {
  Say '  could not inspect running processes (continuing)'
}
if ($stopped -gt 0) {
  Say "Stopped $stopped older agent process(es)"
} else {
  Say 'Nothing was running'
}

# A lock left behind by a process we just killed would otherwise have to age out.
$lock = Join-Path $env:PROGRAMDATA 'SaiAgent\agent.lock'
if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue }

# --- 3. Fetch ----------------------------------------------------------------
Say 'Downloading the agent ...'
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
try {
  Invoke-WebRequest -Uri "$Repo/agent/sai-agent.js" -OutFile $AgentJs -UseBasicParsing
} catch {
  Write-Host ''
  Write-Host "  Could not download the agent: $($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host '  Check this PC has internet access, then run this again.'
  Write-Host ''
  return
}
$sizeKb = [math]::Round((Get-Item $AgentJs).Length / 1KB, 1)
Say "Installed to $AgentJs ($sizeKb KB)"

# --- 4. Start automatically, with no window ----------------------------------
# Node has no windowless build, so a console window appears however the agent is
# launched — and a window a shopkeeper can close is a window that gets closed, which
# stops the shop syncing with nothing on screen to say so. wscript.exe launches it
# hidden, which needs no extra software and no administrator rights.
#
# Hidden must not mean blind: output is appended to agent.log, and the agent keeps
# reporting its own liveness to the cloud every 30 seconds.
Say 'Setting it to start automatically in the background ...'

$HiddenVbs = Join-Path $Dest 'run-agent-hidden.vbs'
try {
  Invoke-WebRequest -Uri "$Repo/scripts/run-agent-hidden.vbs" -OutFile $HiddenVbs -UseBasicParsing
} catch {
  Say "  could not download the background launcher: $($_.Exception.Message)"
  $HiddenVbs = $null
}

$startup = [Environment]::GetFolderPath('Startup')
$shortcut = Join-Path $startup 'Sai Agent.lnk'
try {
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut($shortcut)
  if ($HiddenVbs) {
    $lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $lnk.Arguments  = "`"$HiddenVbs`""
  } else {
    # No launcher: a visible window is far better than no agent at all.
    $lnk.TargetPath = $node.Source
    $lnk.Arguments  = "`"$AgentJs`""
  }
  $lnk.WorkingDirectory = $Dest
  $lnk.Description      = 'Sai Traders store agent'
  $lnk.Save()
  if ($HiddenVbs) {
    Say 'Will start in the background when this user signs in - no window to close'
  } else {
    Say 'Will start when this user signs in'
  }
} catch {
  Say 'Could not set auto-start (not fatal - you can start it by hand)'
}

# A way to start it now, in the background, without signing out and in again.
if ($HiddenVbs) {
  $starter = Join-Path $Dest 'Start Sai Agent.bat'
  @(
    '@echo off'
    'rem Start the Sai agent in the background. Safe to run twice: the agent takes a'
    'rem single-instance lock, so a second copy stands down instead of competing.'
    "wscript.exe `"$HiddenVbs`""
  ) -join "`r`n" | Out-File -FilePath $starter -Encoding ascii
  Say "To start it later without signing out: $starter"
}

# --- 5. Tally reminder -------------------------------------------------------
# Checked rather than assumed, because this is the one thing the agent cannot fix.
Say 'Checking TallyPrime ...'
$tallyUp = $false
try {
  $probe = New-Object System.Net.Sockets.TcpClient
  $probe.Connect('127.0.0.1', 9000)
  $tallyUp = $probe.Connected
  $probe.Close()
} catch { $tallyUp = $false }

if ($tallyUp) {
  Say 'TallyPrime is answering on port 9000 - ok'
} else {
  Write-Host ''
  Write-Host '  TallyPrime is not answering on port 9000.' -ForegroundColor Yellow
  Write-Host '  The agent will still connect, but it cannot read stock until Tally is open.'
  Write-Host ''
  Write-Host '  In TallyPrime:  F1 > Settings > Connectivity'
  Write-Host '      TallyPrime acts as : Both'
  Write-Host '      Port               : 9000'
  Write-Host ''
}

# --- 6. Run ------------------------------------------------------------------
# A PC that has never paired must show its code, so the first run is visible. Once it
# has an identity there is nothing to read, so it goes straight to the background and
# the window closes with the installer.
$TokenFile = Join-Path ($env:PROGRAMDATA) 'SaiAgent\device.enc'
$AlreadyPaired = Test-Path $TokenFile

if ($AlreadyPaired -and $HiddenVbs) {
  Head 'STARTING IN THE BACKGROUND'
  Write-Host '  This PC is already connected, so the agent needs no attention.'
  Write-Host '  It is starting with no window and will keep running after you close this.'
  Write-Host ''
  Write-Host "  Log:   $(Join-Path $Dest 'agent.log')"
  Write-Host '  Check: open the dashboard — it shows whether this PC is reporting.'
  Write-Host ''
  & wscript.exe "$HiddenVbs"
  Start-Sleep -Seconds 3

  $running = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*sai-agent.js*' })
  if ($running.Count -gt 0) {
    Write-Host '  Running.' -ForegroundColor Green
  } else {
    Write-Host '  It did not start. Starting it visibly instead so you can see why:' -ForegroundColor Yellow
    Write-Host ''
    & node $AgentJs
  }
  return
}

Head 'STARTING'
Write-Host '  A six-character code will appear below.'
Write-Host '  Enter it in the Sai Traders admin to connect this PC.'
Write-Host ''
if ($HiddenVbs) {
  Write-Host '  After it says connected, you can close this window — from the next sign-in'
  Write-Host '  it starts in the background with no window at all.'
  Write-Host ''
}

& node $AgentJs
