@echo off
rem Restart trae2api gateway (use after switching account in Trae client).
rem Kills the node process on :19950, relaunches hidden, shows current account.
setlocal
echo [1/3] Stopping gateway on port 19950 ...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":19950" ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1
ping -n 2 127.0.0.1 >nul

echo [2/3] Launching gateway (hidden) ...
wscript "%~dp0launch-hidden.vbs"

echo [3/3] Waiting 6s then checking status ...
ping -n 7 127.0.0.1 >nul
curl -s -m 8 http://127.0.0.1:19950/v1/status -H "Authorization: Bearer sk-trae2api-local" | findstr /C:"account" /C:"token_expires_at"
if errorlevel 1 echo (status check failed - gateway may still be starting, try again in a few seconds)
echo.
pause
