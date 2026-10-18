@echo off
rem 제어판 "프로그램 제거"에서 호출되는 제거 진입점 (/quiet 로 조용히 제거)
set ARGS=
if /I "%~1"=="/quiet" set ARGS=-Quiet
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %ARGS%
