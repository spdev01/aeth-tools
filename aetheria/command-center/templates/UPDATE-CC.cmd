@echo off
chcp 65001 >nul
title Aetheria Command Center updater
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0UPDATE-CC.ps1" %*
echo.
pause
