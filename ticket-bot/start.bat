@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 20+ is required. Install it from https://nodejs.org then run this again. & pause & exit /b 1)
if not exist .env (copy .env.example .env >nul & echo Created .env - fill in DISCORD_TOKEN, then run this again. & pause & exit /b 1)
if not exist node_modules call npm install
node src/index.js
pause
