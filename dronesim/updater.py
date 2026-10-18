"""GitHub Releases 기반 자동 업데이트.

흐름
  1. 프로그램 시작 시 백그라운드로 최신 릴리스(https://api.github.com/repos/<repo>/releases/latest) 확인
  2. 현재 버전보다 새 버전이면 설치 자산을 내려받고 SHA256SUMS.txt 로 무결성 검증
  3. 사용자가 '지금 적용'을 누르거나 프로그램을 종료할 때 적용 스크립트(PowerShell)를 분리 실행
     - 설치형(%LOCALAPPDATA%\\Programs\\DroneMissionSim): DroneMissionSim-Setup.exe /Q 조용한 재설치
     - 포터블(그 외 위치의 단일 exe): 종료 후 exe 파일 교체
     - 소스 실행(개발 모드): 확인만 하고 적용하지 않음
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import tempfile
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import httpx

REPO = "jeegupapa/DG-releases"      # 릴리스 전용 공개 저장소 (소스 저장소 jeegupapa/DG 는 비공개)
API_LATEST = "https://api.github.com/repos/{repo}/releases/latest"
ASSET_SETUP = "DroneMissionSim-Setup.exe"
ASSET_EXE = "DroneMissionSim.exe"
ASSET_SUMS = "SHA256SUMS.txt"
APP_DIR_NAME = "DroneMissionSim"
USER_AGENT = "DroneMissionSim-Updater"

MODE_INSTALLER, MODE_PORTABLE, MODE_SOURCE = "installer", "portable", "source"
STATES = ("idle", "checking", "none", "available", "downloading", "ready", "error", "disabled")


# ---------------------------------------------------------------- 버전

def parse_version(s: str) -> tuple[int, ...]:
    """'v1.2.3' / '1.2.3-beta' → (1, 2, 3). 숫자가 아닌 꼬리는 무시."""
    s = (s or "").strip()
    if s[:1] in ("v", "V"):
        s = s[1:]
    parts: list[int] = []
    for p in s.split("."):
        digits = ""
        for ch in p:
            if ch.isdigit():
                digits += ch
            else:
                break
        parts.append(int(digits) if digits else 0)
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts)


def is_newer(latest: str, current: str) -> bool:
    return parse_version(latest) > parse_version(current)


# ---------------------------------------------------------------- 릴리스 정보

@dataclass
class ReleaseInfo:
    version: str
    tag: str
    html_url: str
    notes: str
    assets: dict[str, str] = field(default_factory=dict)      # 이름 → 다운로드 URL
    sizes: dict[str, int] = field(default_factory=dict)       # 이름 → 바이트
    sha256: dict[str, str] = field(default_factory=dict)      # 이름 → 해시

    def to_dict(self) -> dict[str, Any]:
        return {"version": self.version, "tag": self.tag, "html_url": self.html_url, "notes": self.notes,
                "assets": dict(self.assets), "sizes": dict(self.sizes), "sha256": dict(self.sha256)}


def parse_release(payload: dict[str, Any]) -> ReleaseInfo:
    tag = str(payload.get("tag_name") or payload.get("name") or "")
    info = ReleaseInfo(version=tag[1:] if tag[:1] in ("v", "V") else tag, tag=tag,
                       html_url=str(payload.get("html_url") or ""), notes=str(payload.get("body") or ""))
    for a in payload.get("assets") or []:
        name = str(a.get("name") or "")
        url = str(a.get("browser_download_url") or "")
        if name and url:
            info.assets[name] = url
            info.sizes[name] = int(a.get("size") or 0)
    return info


def parse_sums(text: str) -> dict[str, str]:
    """'<sha256>  <파일명>' 또는 '<sha256> *<파일명>' 줄을 파싱."""
    out: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        digest, name = parts[0].lower(), parts[1].strip().lstrip("*").strip()
        if len(digest) == 64:
            out[name] = digest
    return out


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


class UpdateError(RuntimeError):
    pass


def _headers() -> dict[str, str]:
    return {"Accept": "application/vnd.github+json", "User-Agent": USER_AGENT}


def fetch_latest(repo: str = REPO, client: httpx.Client | None = None) -> ReleaseInfo | None:
    """최신 릴리스 정보(+ 체크섬). 릴리스가 하나도 없으면 None."""
    own = client is None
    client = client or httpx.Client(timeout=20.0, follow_redirects=True)
    try:
        r = client.get(API_LATEST.format(repo=repo), headers=_headers())
        if r.status_code == 404:
            return None
        if r.status_code != 200:
            raise UpdateError(f"릴리스 조회 실패({r.status_code})")
        info = parse_release(r.json())
        sums_url = info.assets.get(ASSET_SUMS)
        if sums_url:
            s = client.get(sums_url, headers={"User-Agent": USER_AGENT})
            if s.status_code == 200:
                info.sha256 = parse_sums(s.text)
        return info
    except httpx.HTTPError as e:
        raise UpdateError(f"업데이트 서버에 연결할 수 없습니다: {e}") from e
    finally:
        if own:
            client.close()


def download(url: str, dest: Path, expected_sha256: str | None = None, client: httpx.Client | None = None,
             progress: Callable[[int, int], None] | None = None) -> Path:
    """url 을 dest 로 내려받고 해시를 검증한다. 이미 올바른 파일이 있으면 그대로 둔다."""
    if dest.exists() and expected_sha256 and sha256_file(dest) == expected_sha256.lower():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    own = client is None
    client = client or httpx.Client(timeout=60.0, follow_redirects=True)
    try:
        with client.stream("GET", url, headers={"User-Agent": USER_AGENT}) as r:
            if r.status_code != 200:
                raise UpdateError(f"다운로드 실패({r.status_code})")
            total = int(r.headers.get("Content-Length") or 0)
            done = 0
            with open(part, "wb") as f:
                for chunk in r.iter_bytes(256 * 1024):
                    f.write(chunk)
                    done += len(chunk)
                    if progress:
                        progress(done, total)
    except httpx.HTTPError as e:
        raise UpdateError(f"다운로드 중 연결 오류: {e}") from e
    finally:
        if own:
            client.close()
    if expected_sha256:
        actual = sha256_file(part)
        if actual != expected_sha256.lower():
            part.unlink(missing_ok=True)
            raise UpdateError("다운로드한 파일의 SHA-256 이 릴리스 체크섬과 다릅니다. 적용하지 않습니다.")
    if dest.exists():
        dest.unlink()
    part.rename(dest)
    return dest


# ---------------------------------------------------------------- 설치 형태

def install_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(base) / "Programs" / APP_DIR_NAME


def detect_mode() -> str:
    if not getattr(sys, "frozen", False):
        return MODE_SOURCE
    exe = Path(sys.executable).resolve()
    try:
        if exe.parent.resolve() == install_dir().resolve():
            return MODE_INSTALLER
    except OSError:
        pass
    return MODE_PORTABLE


def required_asset(mode: str) -> str:
    return ASSET_SETUP if mode == MODE_INSTALLER else ASSET_EXE


# ---------------------------------------------------------------- 적용 스크립트

APPLY_SCRIPT = r"""# DroneMissionSim 업데이트 적용 (자동 생성)
param([int]$ProcId, [string]$Mode, [string]$NewFile, [string]$Exe, [switch]$Relaunch)
$ErrorActionPreference = "SilentlyContinue"
if ($ProcId -gt 0) { Wait-Process -Id $ProcId -Timeout 120 }
Start-Sleep -Milliseconds 700
Get-Process -Name "DroneMissionSim" | Where-Object { $_.Id -ne $PID } | Stop-Process -Force
Start-Sleep -Milliseconds 300
if ($Mode -eq "installer") {
    Start-Process -FilePath $NewFile -ArgumentList "/Q" -Wait
} else {
    $bak = "$Exe.old"
    if (Test-Path $bak) { Remove-Item $bak -Force }
    Move-Item -Path $Exe -Destination $bak -Force
    Copy-Item -Path $NewFile -Destination $Exe -Force
    if (-not (Test-Path $Exe)) { Move-Item -Path $bak -Destination $Exe -Force }
}
if ($Relaunch -and (Test-Path $Exe)) { Start-Process -FilePath $Exe }
Start-Sleep -Seconds 3
if ($Mode -ne "installer") { Remove-Item "$Exe.old" -Force }
Remove-Item $MyInvocation.MyCommand.Path -Force
"""


def write_apply_script(directory: Path | None = None) -> Path:
    d = directory or Path(tempfile.gettempdir())
    d.mkdir(parents=True, exist_ok=True)
    p = d / "DroneMissionSim-apply-update.ps1"
    p.write_text(APPLY_SCRIPT, encoding="utf-8-sig")
    return p


def apply_command(script: Path, mode: str, new_file: Path, exe: Path, pid: int, relaunch: bool) -> list[str]:
    cmd = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
           "-File", str(script), "-ProcId", str(pid), "-Mode", mode, "-NewFile", str(new_file), "-Exe", str(exe)]
    if relaunch:
        cmd.append("-Relaunch")
    return cmd


def launch_detached(cmd: list[str]) -> None:
    flags = 0
    if os.name == "nt":
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP   # type: ignore[attr-defined]
    subprocess.Popen(cmd, creationflags=flags, close_fds=True,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


# ---------------------------------------------------------------- 상태 머신

class Updater:
    def __init__(self, current_version: str, *, repo: str = REPO, mode: str | None = None,
                 cache_dir: Path | None = None, client_factory: Callable[[], httpx.Client] | None = None,
                 exe_path: Path | None = None):
        self.current = current_version
        self.repo = repo
        self.mode = mode or detect_mode()
        self.cache_dir = cache_dir or (Path(tempfile.gettempdir()) / "DroneMissionSim-updates")
        self._client_factory = client_factory or (lambda: httpx.Client(timeout=60.0, follow_redirects=True))
        self.exe_path = exe_path or (Path(sys.executable) if getattr(sys, "frozen", False) else None)
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self.state = "idle"
        self.message = ""
        self.latest: ReleaseInfo | None = None
        self.file: Path | None = None
        self.progress = 0.0
        self.applied = False

    # ------------------------------------------------------------ 조회
    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "state": self.state, "message": self.message, "current": self.current, "mode": self.mode,
                "latest": self.latest.to_dict() if self.latest else None,
                "file": str(self.file) if self.file else None, "progress": round(self.progress, 3),
                "can_apply": self.state == "ready" and self.mode != MODE_SOURCE and not self.applied,
            }

    def _set(self, state: str, message: str = "", **kw: Any) -> None:
        with self._lock:
            self.state = state
            self.message = message
            for k, v in kw.items():
                setattr(self, k, v)

    # ------------------------------------------------------------ 확인·다운로드
    def check_async(self, download_update: bool = True) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self.check, args=(download_update,), daemon=True)
        self._thread.start()

    def check(self, download_update: bool = True) -> dict[str, Any]:
        self._set("checking", "새 버전 확인 중", progress=0.0)
        try:
            with self._client_factory() as client:
                info = fetch_latest(self.repo, client)
                if info is None or not info.version:
                    # 비공개 저장소는 인증 없는 조회에서 404 가 나므로 릴리스가 있어도 여기로 온다.
                    self._set("none", f"릴리스를 찾을 수 없습니다 ({self.repo}). 아직 배포가 없거나 저장소가 비공개입니다.")
                    return self.status()
                if not is_newer(info.version, self.current):
                    self._set("none", f"최신 버전입니다 (v{self.current}).", latest=info)
                    return self.status()
                asset = required_asset(self.mode)
                if self.mode == MODE_SOURCE:
                    self._set("available", f"새 버전 v{info.version} 이 있습니다. 개발 모드에서는 자동 적용하지 않습니다.", latest=info)
                    return self.status()
                if asset not in info.assets:
                    self._set("error", f"릴리스 v{info.version} 에 {asset} 자산이 없습니다.", latest=info)
                    return self.status()
                if not download_update:
                    self._set("available", f"새 버전 v{info.version} 이 있습니다.", latest=info)
                    return self.status()
                self._set("downloading", f"v{info.version} 다운로드 중", latest=info)
                dest = self.cache_dir / info.version / asset
                expected = info.sha256.get(asset)

                def prog(done: int, total: int) -> None:
                    with self._lock:
                        self.progress = (done / total) if total else 0.0

                download(info.assets[asset], dest, expected, client, prog)
                note = "" if expected else " (체크섬 없음: 릴리스에 SHA256SUMS.txt 가 없어 해시 검증을 건너뜀)"
                self._set("ready", f"v{info.version} 준비 완료{note}", latest=info, file=dest, progress=1.0)
        except UpdateError as e:
            self._set("error", str(e))
        except Exception as e:  # 네트워크 외 예외도 화면에 보이게
            self._set("error", f"{type(e).__name__}: {e}")
        return self.status()

    # ------------------------------------------------------------ 적용
    def apply(self, relaunch: bool = True, launcher: Callable[[list[str]], None] | None = None) -> dict[str, Any]:
        st = self.status()
        if not st["can_apply"] or self.file is None or self.exe_path is None:
            return {"ok": False, "error": st["message"] or "적용할 업데이트가 없습니다."}
        script = write_apply_script()
        cmd = apply_command(script, self.mode, self.file, self.exe_path, os.getpid(), relaunch)
        (launcher or launch_detached)(cmd)
        with self._lock:
            self.applied = True
        return {"ok": True, "command": cmd}
