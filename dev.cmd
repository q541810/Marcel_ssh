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

REM Auto-install dependencies if node_modules is missing or outdated
if not exist "node_modules\.pnpm" (
    echo  [INFO] Dependencies missing, installing...
    call pnpm install
    echo.
    if %ERRORLEVEL% neq 0 (
        echo  [ERROR] Failed to install dependencies. Run: pnpm install
        pause
        exit /b 1
    )
) else (
    REM Quick check: verify critical dependency exists
    if not exist "node_modules\@tauri-apps\cli" (
        echo  [INFO] Critical dependency missing, installing...
        call pnpm install
        echo.
        if %ERRORLEVEL% neq 0 (
            echo  [ERROR] Failed to install dependencies. Run: pnpm install
            pause
            exit /b 1
        )
    )
)

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
