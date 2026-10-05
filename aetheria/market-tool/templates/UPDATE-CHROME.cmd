@echo off
chcp 65001 >nul
title Aetheria Market+ updater
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0UPDATE-CHROME.ps1" %*
echo.
pause
