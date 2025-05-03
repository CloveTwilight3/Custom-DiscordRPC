@echo off
echo Starting Discord Rich Presence Status Tracker...
echo.
echo This window will stay open while the app is running.
echo Close this window to stop the app.
echo.
echo Press Ctrl+C to exit
echo.

rem Check if we're in the Windows directory or root directory
if exist src (
  rem We are likely in the windows directory already
  cd /d "%~dp0"
) else if exist windows (
  rem We are in the root directory, navigate to windows
  cd /d "%~dp0windows"
) else (
  echo Error: Cannot find the application directory.
  echo Please make sure this batch file is in the discord-rpc-status root
  echo or windows directory.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First-time setup: Installing dependencies...
  npm install
)

if not exist dist (
  echo Building TypeScript...
  npm run build
)

echo Starting Discord RPC app...
npm start

pause