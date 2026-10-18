@echo off
rem IExpress 패키지가 압축을 푼 뒤 호출하는 설치 진입점
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
