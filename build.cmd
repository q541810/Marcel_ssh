@echo off
REM ============================================
REM  Marcel SSH - Release Build
REM  构建发布包 (桌面 NSIS / Android APK)
REM ============================================

title Marcel SSH - Build

set "PATH=C:\Program Files\nodejs;%APPDATA%\npm;%PATH%"
cd /d "%~dp0"

echo.
echo  ==========================================
echo    Marcel SSH (玛瑟尔 SSH) - Release Build
echo  ==========================================
echo.
echo   [D] Desktop  - Windows NSIS installer
echo   [M] Mobile   - Android APK (aarch64)
echo.
echo   Default = Desktop  (press Enter to accept)
echo.

set "TARGET="
set /p "TARGET=  Choose target [D/M]: "

if /i "%TARGET%"=="" set "TARGET=D"

if /i "%TARGET%"=="D"       goto :desktop
if /i "%TARGET%"=="DESK"    goto :desktop
if /i "%TARGET%"=="DESKTOP" goto :desktop

if /i "%TARGET%"=="M"     goto :mobile
if /i "%TARGET%"=="MOB"   goto :mobile
if /i "%TARGET%"=="MOBILE" goto :mobile

echo.
echo  [ERROR] Unknown target: "%TARGET%"
echo  Please enter D (desktop) or M (mobile).
set "RC=1"
goto :end

:desktop
echo.
echo  Building desktop (NSIS installer)...
echo.

call pnpm tauri build
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
    echo.
    echo  [ERROR] Desktop build failed (exit code %RC%).
    echo  Common fixes:
    echo    1. Run install.cmd to ensure dependencies are up to date
    echo    2. Ensure Rust is installed: https://rustup.rs
)
goto :end

:mobile
echo.
echo  Building Android APK (aarch64)...
echo.

if "%ANDROID_HOME%"=="" set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
if "%NDK_HOME%"==""     set "NDK_HOME=%LOCALAPPDATA%\Android\Sdk\ndk\27.0.12077973"

echo   ANDROID_HOME = %ANDROID_HOME%
echo   NDK_HOME     = %NDK_HOME%
echo.

call pnpm tauri android build --apk --target aarch64
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
    echo.
    echo  [ERROR] Mobile build failed (exit code %RC%).
    echo  Common fixes:
    echo    1. Ensure ANDROID_HOME / NDK_HOME point to a valid SDK
    echo    2. Run install.cmd to ensure dependencies are up to date
)
goto :end

:end
if "%RC%"=="0" (
    echo.
    echo  ==========================================
    echo   Build complete.
    echo   Desktop installer : src-tauri\target\release\bundle\
    echo   Mobile APK        : src-tauri\gen\android\app\build\outputs\apk\universal\release\
    echo  ==========================================
)
echo.
echo  Press any key to close...
pause >nul
exit /b %RC%
