# 제거 스크립트. 설치 폴더 안에서 실행되므로 자신을 %TEMP% 로 복사한 뒤 거기서 다시 실행해 폴더를 지운다.
param([switch]$Quiet, [switch]$FromTemp)
$ErrorActionPreference = "SilentlyContinue"

$AppName     = "DroneMissionSim"
$DisplayName = "드론 임무 시뮬레이터"
$Dest = Join-Path $env:LOCALAPPDATA "Programs\$AppName"

if (-not $FromTemp) {
    $tmp = Join-Path $env:TEMP "$AppName-uninstall.ps1"
    Copy-Item -Path $MyInvocation.MyCommand.Path -Destination $tmp -Force
    $args = "-NoProfile -ExecutionPolicy Bypass -File `"$tmp`" -FromTemp"
    if ($Quiet) { $args += " -Quiet" }
    Start-Process -FilePath "powershell.exe" -ArgumentList $args -WindowStyle Hidden
    exit 0
}

Get-Process -Name $AppName | Stop-Process -Force
Start-Sleep -Milliseconds 800

$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$desktop   = [Environment]::GetFolderPath("Desktop")
foreach ($dir in @($startMenu, $desktop)) {
    Remove-Item -Path (Join-Path $dir "$DisplayName.lnk") -Force
}
Remove-Item -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$AppName" -Recurse -Force
Remove-Item -Path $Dest -Recurse -Force

if (-not $Quiet) {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show("$DisplayName 이(가) 제거되었습니다.", $DisplayName) | Out-Null
}
Remove-Item -Path $MyInvocation.MyCommand.Path -Force
