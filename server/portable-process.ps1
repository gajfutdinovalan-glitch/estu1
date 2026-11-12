function Get-EstuProcess([string]$Marker, [string]$PythonPath) {
  if (-not (Test-Path -LiteralPath $Marker)) { return }
  $processId = 0
  $line = Get-Content -LiteralPath $Marker -TotalCount 1
  if (-not [int]::TryParse($line, [ref]$processId) -or $processId -le 0) { return }
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($process -and $process.Path -eq $PythonPath) { return $process }
}

function Get-EstuListeningPort([int]$ProcessId) {
  $pattern = "^\s*TCP\s+127\.0\.0\.1:(\d+)\s+0\.0\.0\.0:0\s+\S+\s+${ProcessId}\s*$"
  foreach ($line in (& "$env:SystemRoot\System32\netstat.exe" -ano -p tcp)) {
    if ($line -match $pattern) { return [int]$Matches[1] }
  }
}
