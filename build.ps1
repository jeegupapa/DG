# Windows 단일 실행파일 빌드
#   .\build.ps1          → dist\DroneMissionSim.exe
# PyInstaller는 진행 로그를 stderr로 출력하므로 ErrorActionPreference=Stop을 쓰지 않고
# 종료 코드($LASTEXITCODE)로 성공 여부를 판정한다.
$ErrorActionPreference = "Continue"
$py = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
    Write-Error "가상환경이 없습니다. python -m venv .venv; .venv\Scripts\pip install -r requirements.txt"
    exit 1
}

& $py -m PyInstaller --noconfirm --clean --onefile --windowed --log-level WARN `
    --name DroneMissionSim `
    --add-data "dronesim\ui;dronesim\ui" `
    --add-data "dronesim\data;dronesim\data" `
    --hidden-import webview.platforms.edgechromium `
    run.py

if ($LASTEXITCODE -ne 0) {
    Write-Error "PyInstaller 빌드 실패 (exit $LASTEXITCODE)"
    exit $LASTEXITCODE
}
Write-Host "완료: $(Join-Path $PSScriptRoot 'dist\DroneMissionSim.exe')"
