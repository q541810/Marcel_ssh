@echo off
REM ============================================
REM  Marcel SSH - Development Launcher
REM  启动 Tauri 开发模式 (前端 + Rust 后端)
REM ============================================

title Marcel SSH - Dev

REM Add Node.js and npm global bin to PATH
set "PATH=C:\Program Files\nodejs;%APPDATA%\npm;%PATH%"

REM Navigate to project root
cd /d "%~dp0"

echo.
echo  ==========================================
echo    Marcel SSH (玛瑟尔 SSH) - Dev Mode
echo  ==========================================
echo.
echo  Starting Tauri development server...
echo    - Vite dev server (frontend): http://localhost:1420
echo    - Rust backend: auto-compiled and launched
echo.
echo  First launch may take 1-2 minutes for Rust compilation.
echo  The application window will open automatically.
echo.
echo  Press Ctrl+C to stop.
echo.

REM Launch tauri dev (will start Vite + compile Rust + open window)
node "./node_modules/@tauri-apps/cli/tauri.js" dev

if %ERRORLEVEL% neq 0 (
    echo.
    echo  [ERROR] Failed to start. Common fixes:
    echo    1. Run: pnpm install
    echo    2. Ensure Rust is installed: rustup.rs
    echo    3. Check port 1420 is free
    echo.
    pause
)
