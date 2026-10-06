@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 20+ is required. Install it from https://nodejs.org then run this again. & pause & exit /b 1)
if not exist .env (copy .env.example .env >nul & echo Created .env - fill in DISCORD_TOKEN, then run this again. & pause & exit /b 1)
call npm install --no-audit --no-fund
node src/index.js
pause
