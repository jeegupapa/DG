# 설치파일 생성 (Windows 내장 IExpress 사용, 별도 도구 설치 불필요)
#   1) .\build.ps1                  → dist\DroneMissionSim.exe
#   2) .\installer\make_installer.ps1 → dist\DroneMissionSim-Setup.exe
# 설치파일은 사용자 계정 범위로 설치하며 관리자 권한을 요구하지 않는다.
# 조용한 설치: DroneMissionSim-Setup.exe /Q
$ErrorActionPreference = "Stop"

$Root = $PSScriptRoot
$Proj = Split-Path -Parent $Root
$Exe  = Join-Path $Proj "dist\DroneMissionSim.exe"
if (-not (Test-Path $Exe)) { throw "dist\DroneMissionSim.exe 가 없습니다. 먼저 .\build.ps1 을 실행하세요." }

$Payload = Join-Path $Root "payload"
if (Test-Path $Payload) { Remove-Item -Recurse -Force $Payload }
New-Item -ItemType Directory -Path $Payload | Out-Null
foreach ($f in @($Exe, "$Root\install.cmd", "$Root\install.ps1", "$Root\uninstall.cmd", "$Root\uninstall.ps1")) {
    Copy-Item -Path $f -Destination $Payload
}

$Target = Join-Path $Proj "dist\DroneMissionSim-Setup.exe"
if (Test-Path $Target) { Remove-Item -Force $Target }

# IExpress 는 SED 파일을 ANSI 로 읽는다. 한국어 코드페이지(949)가 아니면 영문 문구를 쓴다.
$korean = ([System.Text.Encoding]::Default.CodePage -eq 949)
if ($korean) {
    $friendly = "드론 임무 시뮬레이터 설치"
    $prompt   = "드론 임무 시뮬레이터 0.1.0 을 설치하시겠습니까? (시작 메뉴와 바탕화면에 바로가기가 만들어집니다)"
    $finish   = "설치가 완료되었습니다. 시작 메뉴 또는 바탕화면의 '드론 임무 시뮬레이터'로 실행하세요."
} else {
    $friendly = "Drone Mission Simulator Setup"
    $prompt   = "Install Drone Mission Simulator 0.1.0? (Start menu and desktop shortcuts will be created)"
    $finish   = "Installation complete. Launch 'Drone Mission Simulator' from the Start menu or desktop."
}

$sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=%InstallPrompt%
DisplayLicense=%DisplayLicense%
FinishMessage=%FinishMessage%
TargetName=%TargetName%
FriendlyName=%FriendlyName%
AppLaunched=%AppLaunched%
PostInstallCmd=%PostInstallCmd%
AdminQuietInstCmd=%AdminQuietInstCmd%
UserQuietInstCmd=%UserQuietInstCmd%
SourceFiles=SourceFiles
[Strings]
InstallPrompt=$prompt
DisplayLicense=
FinishMessage=$finish
TargetName=$Target
FriendlyName=$friendly
AppLaunched=powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File install.ps1
PostInstallCmd=<None>
AdminQuietInstCmd=powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File install.ps1 -Quiet
UserQuietInstCmd=powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File install.ps1 -Quiet
FILE0="DroneMissionSim.exe"
FILE1="install.cmd"
FILE2="install.ps1"
FILE3="uninstall.cmd"
FILE4="uninstall.ps1"
[SourceFiles]
SourceFiles0=$Payload\
[SourceFiles0]
%FILE0%=
%FILE1%=
%FILE2%=
%FILE3%=
%FILE4%=
"@

$SedPath = Join-Path $Root "DroneMissionSim.sed"
# IExpress 는 CRLF 줄바꿈과 ANSI 인코딩을 요구한다.
$sed = ($sed -replace "`r?`n", "`r`n") + "`r`n"
[System.IO.File]::WriteAllText($SedPath, $sed, [System.Text.Encoding]::Default)

# IExpress 는 따옴표로 감싼 경로를 그대로 파일명으로 취급해 열지 못한다.
# 따옴표 없이 넘기되, 공백이 있어도 되도록 8.3 단축 경로를 사용한다.
$fso = New-Object -ComObject Scripting.FileSystemObject
$SedShort = $fso.GetFile($SedPath).ShortPath
$iexpress = Join-Path $env:SystemRoot "System32\iexpress.exe"
$p = Start-Process -FilePath $iexpress -ArgumentList @("/N", "/Q", $SedShort) -Wait -PassThru
if (-not (Test-Path $Target)) { throw "IExpress 빌드 실패 (exit $($p.ExitCode)). $SedPath 를 iexpress.exe 로 열어 확인하세요." }

$mb = [math]::Round((Get-Item $Target).Length / 1MB, 1)
Write-Host "완료: $Target ($mb MB)"
