param([switch]$NoExplorer)

$ErrorActionPreference = "Stop"
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$python = Join-Path $PSScriptRoot "runtime\python\python.exe"
if (-not (Test-Path -LiteralPath $python)) { throw "Portable Python was not found. Start ESTU once before export." }
$directory = Join-Path $root "Exports"
New-Item -ItemType Directory -Force -Path $directory | Out-Null
$destination = Join-Path $directory ("ESTU-Test-{0}.zip" -f ([DateTime]::Now.ToString("yyyy-MM-dd_HH-mm-ss")))
& $python -X utf8 (Join-Path $PSScriptRoot "portable_export.py") $destination
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $destination)) { throw "ESTU export failed." }
if (-not $NoExplorer) {
  try { Start-Process explorer.exe -ArgumentList @("/select,`"$destination`"") }
  catch { Write-Warning "Export is saved, but Explorer could not be opened. See $destination" }
}

