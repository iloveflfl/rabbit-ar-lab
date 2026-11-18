@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Rabbit AR Server (LM Studio)
where node >nul 2>nul || (echo [ERROR] Node.js not found. Install Node.js first. & pause & exit /b 1)
where lms >nul 2>nul || echo [WARN] lms command not found. Open LM Studio once and enable its command line tool.
if not exist desktop-server.env (echo [ERROR] desktop-server.env not found. Copy desktop-server.env.example and fill it in. & pause & exit /b 1)
if not exist node_modules (echo Installing packages... & call npm install)
:loop
call npx tsx scripts/desktop-device.ts
set CODE=%errorlevel%
if "%CODE%"=="0" goto done
if "%CODE%"=="2" goto done
echo.
echo [RESTART] Server exited unexpectedly (code %CODE%). Restarting in 5 seconds... Close this window to stop.
timeout /t 5 /nobreak >nul
goto loop
:done
echo.
echo Server stopped (code %CODE%).
pause
