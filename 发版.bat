@echo off
REM ============================================================
REM  Cloud Dashboard - Publish to Production (one click)
REM
REM  Does three things:
REM    1. npm run build          rebuild frontend into dist/
REM    2. pm2 restart backend    make Express re-read dist/
REM    3. show status + URLs
REM
REM  When to use: after changing ANYTHING under src/
REM  If you only changed server/ code, just run:
REM      npx pm2 restart cloud-dashboard
REM
REM  NOTE: this file is pure ASCII on purpose - Chinese comments
REM  get garbled in cmd.exe. Keep it that way.
REM ============================================================

setlocal
cd /d "%~dp0"

echo.
echo ==========================================
echo   Cloud Dashboard - Publish to Production
echo ==========================================
echo.

echo [1/3] Building frontend...
call npm run build
if errorlevel 1 (
    echo.
    echo [FAILED] Build failed. Nothing was published.
    echo.
    pause
    exit /b 1
)
echo.

echo [2/3] Restarting backend service...
call npx pm2 restart cloud-dashboard
if errorlevel 1 (
    echo.
    echo [FAILED] PM2 restart failed.
    echo.
    pause
    exit /b 1
)
echo.

echo [3/3] Current status:
call npx pm2 list
echo.
echo ==========================================
echo   Done. Live at:
echo     https://www.tjhd.dpdns.org
echo   Local:
echo     http://localhost:5173   (dev server)
echo     http://localhost:3000   (built output)
echo ==========================================
echo.
pause
