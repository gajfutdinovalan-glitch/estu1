param([int]$Port = 8080, [switch]$NoShortcut, [switch]$NoBrowser)

$ErrorActionPreference = "Stop"
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$python = Join-Path $PSScriptRoot "runtime\python\python.exe"
$serverScript = Join-Path $PSScriptRoot "portable_server.py"
$workerScript = Join-Path $PSScriptRoot "navcontrol\mail_worker.py"
$dataDir = Join-Path $PSScriptRoot "data"
. (Join-Path $PSScriptRoot "portable-process.ps1")
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

function Get-PortablePython {
  if (Test-Path -LiteralPath $python) {
    try {
      & $python -c "import sqlite3, sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)" 2>$null
      if ($LASTEXITCODE -eq 0) { return $python }
    } catch {}
  }
  return (& (Join-Path $PSScriptRoot "ensure-python.ps1") -Quiet | Select-Object -Last 1)
}

function Test-PortableServer([int]$CandidatePort) {
  try {
    $response = Invoke-RestMethod -Uri "http://127.0.0.1:$CandidatePort/api/auth/status" -TimeoutSec 2
    return $response.portable -eq $true
  } catch { return $false }
}

function Test-PortOpen([int]$CandidatePort) {
  $client = [Net.Sockets.TcpClient]::new()
  try {
    $task = $client.ConnectAsync("127.0.0.1", $CandidatePort)
    return $task.Wait(250) -and $client.Connected
  } catch { return $false }
  finally { $client.Dispose() }
}

$python = Get-PortablePython
$serverPidPath = Join-Path $dataDir "portable-server.pid"
$server = Get-EstuProcess $serverPidPath $python
if ($server) {
  $runningPort = Get-EstuListeningPort $server.Id
  if (-not $runningPort -or -not (Test-PortableServer $runningPort)) {
    throw "ESTU from this folder is running but not responding. Try ESTU STOP.cmd, then ESTU START.cmd."
  }
  $Port = $runningPort
} else {
  $selectedPort = $Port..($Port + 30) | Where-Object { -not (Test-PortOpen $_) } | Select-Object -First 1
  if ($null -eq $selectedPort) { throw "No free local port was found for ESTU." }
  $Port = $selectedPort
  $startupLog = Join-Path $dataDir "portable-startup.log"
  $server = Start-Process -FilePath $python `
    -ArgumentList @("-X", "utf8", "`"$serverScript`"", "--port", [string]$Port) `
    -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $dataDir "portable-server.stdout.log") `
    -RedirectStandardError $startupLog -PassThru
  $ready = $false
  for ($attempt=0; $attempt -lt 60; $attempt++) {
    Start-Sleep -Milliseconds 250
    if ($server.HasExited) { break }
    if ((Test-PortableServer $Port) -and (Get-EstuListeningPort $server.Id) -eq $Port) {
      $ready = $true
      break
    }
  }
  if (-not $ready) {
    Get-Content -LiteralPath $startupLog -Encoding UTF8 -Tail 20 -ErrorAction SilentlyContinue
    throw "ESTU server did not start. Startup log: $startupLog"
  }
}

$workerPidPath = Join-Path $dataDir "portable-mail-worker.pid"
if (-not (Get-EstuProcess $workerPidPath $python)) {
  $env:ESTU_PORT = [string]$Port
  $env:PYTHONUTF8 = "1"
  $worker = Start-Process -FilePath $python -ArgumentList @("`"$workerScript`"") `
    -WorkingDirectory $PSScriptRoot -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $dataDir "portable-mail.stdout.log") `
    -RedirectStandardError (Join-Path $dataDir "portable-mail.stderr.log") -PassThru
  Set-Content -LiteralPath $workerPidPath -Value $worker.Id -Encoding ASCII
}

function New-EstuShortcuts {
  $desktop = [Environment]::GetFolderPath("Desktop")
  $shell = New-Object -ComObject WScript.Shell
  foreach ($shortcut in @(
    @{ Name="ESTU Test.lnk"; Target=(Join-Path $root "ESTU START.cmd"); Description="Start ESTU portable test" },
    @{ Name="ESTU Export.lnk"; Target=(Join-Path $root "ESTU EXPORT.cmd"); Description="Export ESTU test data" }
  )) {
    $path = Join-Path $desktop $shortcut.Name
    if (-not (Test-Path -LiteralPath $path)) {
      $link = $shell.CreateShortcut($path)
      $link.TargetPath = $shortcut.Target
      $link.WorkingDirectory = $root
      $link.Description = $shortcut.Description
      $link.IconLocation = "$env:SystemRoot\System32\shell32.dll,14"
      $link.Save()
    }
  }
}

if (-not $NoShortcut) {
  try { New-EstuShortcuts }
  catch { Write-Warning "Could not create desktop shortcuts. You can still use the CMD files." }
}

$url = "http://127.0.0.1:$Port/"
Write-Output "ESTU is running at $url"
if (-not $NoBrowser) {
  try { Start-Process $url }
  catch { throw "ESTU is running, but the browser could not be opened. Open $url manually. $($_.Exception.Message)" }
}
