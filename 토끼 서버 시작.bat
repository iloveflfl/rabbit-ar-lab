@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Rabbit AR Server (LM Studio)
echo [1/3] LM Studio server
call lms server start
echo [2/3] Model
lms ps | findstr /i "gemma-4-26b-a4b-it-uncensored" >nul || call lms load gemma-4-26b-a4b-it-uncensored --context-length 16384 --gpu max -y
echo [3/3] Relay
call npm run desktop-device
pause
