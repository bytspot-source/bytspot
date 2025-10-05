@echo off
setlocal ENABLEDELAYEDEXPANSION

REM Change to repo root (this script lives in scripts\)
pushd %~dp0..

start "WEB" cmd /k npm run dev:web
start "AUTH" cmd /k npm run dev:auth
start "VENUE" cmd /k npm run dev:venue
start "BFF" cmd /k npm run dev:bff

popd
endlocal

