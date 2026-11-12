$ErrorActionPreference = "Stop"
$dataDir = Join-Path $PSScriptRoot "data"
$pythonPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "runtime\python\python.exe"))
. (Join-Path $PSScriptRoot "portable-process.ps1")

foreach ($item in @(
  @{ File="portable-mail-worker.pid" },
  @{ File="portable-server.pid" }
)) {
  $pidPath = Join-Path $dataDir $item.File
  if (-not (Test-Path -LiteralPath $pidPath)) { continue }
  $process = Get-EstuProcess $pidPath $pythonPath
  if ($process) {
    Stop-Process -InputObject $process
    if (-not $process.WaitForExit(5000)) { throw "ESTU process did not stop: $($process.Id)" }
  }
  if (Test-Path -LiteralPath $pidPath) { Remove-Item -LiteralPath $pidPath -Force }
}
Write-Output "ESTU from this folder is stopped."
