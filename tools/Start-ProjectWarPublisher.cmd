@echo off
setlocal
cd /d "%~dp0.."
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0ProjectWarPublisher.ps1"
if errorlevel 1 (
  echo Project War Publisher did not start correctly.
  pause
)
