@echo off
setlocal
set "script=%~dp0server\stop-portable.ps1"
if not exist "%script%" (
  echo Required ESTU files are missing. Extract the entire ZIP before running this file.
  goto failed
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%script%" %*
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo ESTU STOP failed. The error is shown above.
pause
exit /b 1

