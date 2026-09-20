@echo off
title WICK SNIPER BOT - Binance Futures HFT Engine
cd /d "%~dp0"
echo =========================================================
echo    🎯 WICK SNIPER BOT - SPIKE REVERSAL ENGINE
echo    Memulai server dan radar WebSocket Binance Futures...
echo =========================================================
npx ts-node src/server.ts
pause
