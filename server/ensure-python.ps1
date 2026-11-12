param([switch]$Quiet)

$ErrorActionPreference = "Stop"
$runtime = Join-Path $PSScriptRoot "runtime\python"
$python = Join-Path $runtime "python.exe"

if (Test-Path -LiteralPath $python) {
  try {
    & $python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)" 2>$null
    if ($LASTEXITCODE -eq 0) { Write-Output $python; exit 0 }
  } catch {}
}

$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -eq "ARM64") {
  $file = "python-3.13.14-embed-arm64.zip"
  $sha = "8b5bfc935a24b55c17410aa0b21016ebeee225c96addf008d1d3cd83ff52eb43"
} elseif ($arch -eq "x86") {
  $file = "python-3.13.14-embed-win32.zip"
  $sha = "dfa69c8fe09c10a725a8f7311d5ce2bb24cddfabcae660cca9d70539ff0b3dab"
} else {
  $file = "python-3.13.14-embed-amd64.zip"
  $sha = "90b4e5b9898b72d744650524bff92377c367f44bd5fbd09e3148656c080ad907"
}

$url = "https://www.python.org/ftp/python/3.13.14/$file"
$zip = Join-Path $env:TEMP $file
if (-not $Quiet) { Write-Host "Загрузка переносимого Python для чтения XLSX и почты..." }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip
$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
if ($actual -ne $sha) { throw "Контрольная сумма переносимого Python не совпала." }
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
Get-ChildItem -LiteralPath $runtime -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
Expand-Archive -LiteralPath $zip -DestinationPath $runtime -Force
$pth = Get-ChildItem -LiteralPath $runtime -Filter "python*._pth" | Select-Object -First 1
if ($null -eq $pth) { throw "В переносимом Python не найден файл ._pth." }
$zipName = (Get-ChildItem -LiteralPath $runtime -Filter "python*.zip" | Select-Object -First 1).Name
@($zipName, ".", "..", "import site") | Set-Content -LiteralPath $pth.FullName -Encoding ASCII
Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
Write-Output $python
