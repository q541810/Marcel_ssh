@echo off
chcp 65001 >nul
REM ============================================
REM  Marcel SSH - Eval Launcher
REM  启动评测台（evals/server.mjs），用法见 evals/README.md
REM ============================================

title Marcel SSH - Eval

set "PATH=C:\Program Files\nodejs;%APPDATA%\npm;%PATH%"
cd /d "%~dp0.."

if "%EVAL_PORT%"=="" set "EVAL_PORT=4780"
set "EVAL_URL=http://127.0.0.1:%EVAL_PORT%"

echo.
echo  ==========================================
echo    Marcel 评测台
echo  ==========================================
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo  [错误] 没找到 Node.js，先安装：https://nodejs.org
    pause
    exit /b 1
)

REM 评测台已经开着：只打开网页，不重复启动（否则端口被占会报错）
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 '%EVAL_URL%/api/state' | Out-Null; exit 0 } catch { exit 1 }"
if not errorlevel 1 (
    echo  评测台已经在运行，直接打开网页：%EVAL_URL%
    start "" "%EVAL_URL%"
    timeout /t 2 >nul
    exit /b 0
)

REM Docker 没开就帮忙打开，并等它就绪
docker info >nul 2>&1
if errorlevel 1 (
    if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" (
        echo  Docker 没启动，正在打开 Docker Desktop，等它就绪（最多 3 分钟）...
        start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
        set /a "WAITED=0"
        call :wait_docker
    ) else (
        echo  [提示] Docker 没启动，也没找到 Docker Desktop。评测台照常打开，开考前请先启动 Docker。
    )
)

echo.
echo  正在启动评测台：%EVAL_URL%
echo  浏览器会自动打开。关掉这个窗口或按 Ctrl+C 即停止评测台。
echo.

node evals/server.mjs

if %ERRORLEVEL% neq 0 (
    echo.
    echo  [错误] 评测台异常退出，看上面的报错。
    pause
)
exit /b %ERRORLEVEL%

:wait_docker
timeout /t 3 /nobreak >nul
docker info >nul 2>&1
if not errorlevel 1 (
    echo  Docker 已就绪。
    exit /b 0
)
set /a "WAITED+=3"
if %WAITED% geq 180 (
    echo  [提示] 等了 3 分钟 Docker 还没就绪。评测台照常打开，Docker 好了再开考。
    exit /b 0
)
goto wait_docker
