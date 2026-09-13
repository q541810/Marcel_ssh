@echo off
REM ============================================
REM  Marcel SSH - Update Test Source
REM  Serves a fake "new version" locally so the
REM  silent update chain can be tested without
REM  publishing a release. See scripts/update-test-source.mjs
REM ============================================

title Marcel SSH - Update Test Source

set "PATH=C:\Program Files\nodejs;%APPDATA%\npm;%PATH%"
cd /d "%~dp0"

echo.
echo  ==========================================
echo    Marcel SSH - Update Test Source
echo  ==========================================
echo.
echo  Options (English help):  node scripts\update-test-source.mjs --help
echo.
echo  Press Ctrl+C to stop the server.
echo.

node "scripts\update-test-source.mjs" %*

if %ERRORLEVEL% neq 0 (
    echo.
    echo  [ERROR] Test source exited with code %ERRORLEVEL%.
    echo    Run: node scripts\update-test-source.mjs --help
    echo.
    pause
)
