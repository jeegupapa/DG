# 설치 스크립트: 사용자 계정 범위(관리자 권한 불필요)로 프로그램을 설치한다.
#   - 파일 복사: %LOCALAPPDATA%\Programs\DroneMissionSim
#   - 시작 메뉴·바탕화면 바로가기
#   - 설정 > 앱 > 설치된 앱(제어판 프로그램 제거)에 등록
param([switch]$Quiet)
$ErrorActionPreference = "Stop"

$AppName     = "DroneMissionSim"
$DisplayName = "드론 임무 시뮬레이터"
$Version     = "0.1.0"
$Publisher   = "DG"
$ExeName     = "DroneMissionSim.exe"

$Src  = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dest = Join-Path $env:LOCALAPPDATA "Programs\$AppName"

# 실행 중이면 종료
Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($ExeName)) -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
foreach ($f in @($ExeName, "uninstall.ps1", "uninstall.cmd")) {
    Copy-Item -Path (Join-Path $Src $f) -Destination $Dest -Force
}
$ExePath = Join-Path $Dest $ExeName

# 바로가기
$ws = New-Object -ComObject WScript.Shell
$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$desktop   = [Environment]::GetFolderPath("Desktop")
foreach ($dir in @($startMenu, $desktop)) {
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $lnk = $ws.CreateShortcut((Join-Path $dir "$DisplayName.lnk"))
    $lnk.TargetPath       = $ExePath
    $lnk.WorkingDirectory = $Dest
    $lnk.Description      = $DisplayName
    $lnk.IconLocation     = "$ExePath,0"
    $lnk.Save()
}

# 제어판 / 설정 > 앱 등록 (현재 사용자)
$key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$AppName"
New-Item -Path $key -Force | Out-Null
$sizeKb = [int]((Get-Item $ExePath).Length / 1KB)
Set-ItemProperty -Path $key -Name DisplayName     -Value $DisplayName
Set-ItemProperty -Path $key -Name DisplayVersion  -Value $Version
Set-ItemProperty -Path $key -Name Publisher       -Value $Publisher
Set-ItemProperty -Path $key -Name InstallLocation -Value $Dest
Set-ItemProperty -Path $key -Name DisplayIcon     -Value $ExePath
Set-ItemProperty -Path $key -Name UninstallString -Value "`"$Dest\uninstall.cmd`""
Set-ItemProperty -Path $key -Name QuietUninstallString -Value "`"$Dest\uninstall.cmd`" /quiet"
Set-ItemProperty -Path $key -Name InstallDate     -Value (Get-Date -Format "yyyyMMdd")
Set-ItemProperty -Path $key -Name NoModify        -Value 1 -Type DWord
Set-ItemProperty -Path $key -Name NoRepair        -Value 1 -Type DWord
Set-ItemProperty -Path $key -Name EstimatedSize   -Value $sizeKb -Type DWord

Write-Host "설치 완료: $Dest"
