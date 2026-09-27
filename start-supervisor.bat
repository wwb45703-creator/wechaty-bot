@echo off
rem Bot supervisor launcher (ASCII-only on purpose)
rem Keeps the wechaty bot alive: auto-restarts it if it dies.
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\supervisor.ps1"
