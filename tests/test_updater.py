import hashlib
import json
from pathlib import Path

import httpx
import pytest

from dronesim import updater as up


def test_parse_version_and_compare():
    assert up.parse_version("v1.2.3") == (1, 2, 3)
    assert up.parse_version("0.2") == (0, 2, 0)
    assert up.parse_version("1.10.0-beta") == (1, 10, 0)
    assert up.is_newer("0.2.0", "0.1.0")
    assert up.is_newer("v0.10.0", "0.9.9")
    assert not up.is_newer("0.2.0", "0.2.0")
    assert not up.is_newer("0.1.9", "0.2.0")


def release_payload(version="0.2.0", with_sums=True):
    assets = [
        {"name": up.ASSET_SETUP, "browser_download_url": f"https://dl.example/{version}/{up.ASSET_SETUP}", "size": 10},
        {"name": up.ASSET_EXE, "browser_download_url": f"https://dl.example/{version}/{up.ASSET_EXE}", "size": 10},
    ]
    if with_sums:
        assets.append({"name": up.ASSET_SUMS, "browser_download_url": f"https://dl.example/{version}/{up.ASSET_SUMS}", "size": 1})
    return {"tag_name": f"v{version}", "html_url": "https://github.com/x/y/releases/tag/v" + version,
            "body": "notes", "assets": assets}


def test_parse_release_and_sums():
    info = up.parse_release(release_payload())
    assert info.version == "0.2.0" and info.tag == "v0.2.0"
    assert set(info.assets) == {up.ASSET_SETUP, up.ASSET_EXE, up.ASSET_SUMS}
    sums = up.parse_sums("abc\n" + "a" * 64 + "  DroneMissionSim.exe\n" + "b" * 64 + " *DroneMissionSim-Setup.exe\n")
    assert sums == {"DroneMissionSim.exe": "a" * 64, "DroneMissionSim-Setup.exe": "b" * 64}


def make_client(version="0.2.0", payload_bytes=b"NEWEXE", bad_sum=False, no_release=False):
    digest = hashlib.sha256(payload_bytes).hexdigest()
    if bad_sum:
        digest = "0" * 64
    sums = f"{digest}  {up.ASSET_SETUP}\n{digest}  {up.ASSET_EXE}\n"
    calls = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(str(req.url))
        u = str(req.url)
        if u.endswith("/releases/latest"):
            return httpx.Response(404, json={}) if no_release else httpx.Response(200, json=release_payload(version))
        if u.endswith(up.ASSET_SUMS):
            return httpx.Response(200, text=sums)
        if u.endswith(".exe"):
            return httpx.Response(200, content=payload_bytes, headers={"Content-Length": str(len(payload_bytes))})
        return httpx.Response(404)

    return (lambda: httpx.Client(transport=httpx.MockTransport(handler))), calls


def test_fetch_latest_reads_checksums():
    factory, _ = make_client()
    with factory() as c:
        info = up.fetch_latest("x/y", c)
    assert info.version == "0.2.0"
    assert up.ASSET_EXE in info.sha256 and len(info.sha256[up.ASSET_EXE]) == 64


def test_fetch_latest_no_release_returns_none():
    factory, _ = make_client(no_release=True)
    with factory() as c:
        assert up.fetch_latest("x/y", c) is None


def test_updater_portable_downloads_and_verifies(tmp_path):
    factory, calls = make_client()
    u = up.Updater("0.1.0", repo="x/y", mode=up.MODE_PORTABLE, cache_dir=tmp_path, client_factory=factory,
                   exe_path=tmp_path / "app.exe")
    st = u.check()
    assert st["state"] == "ready", st
    assert st["can_apply"] and Path(st["file"]).read_bytes() == b"NEWEXE"
    assert st["file"].endswith(up.ASSET_EXE)            # 포터블은 exe 자산
    # 두 번째 확인은 이미 받은 파일을 재사용(다운로드 호출 없음)
    n = len([c for c in calls if c.endswith(".exe")])
    u.check()
    assert len([c for c in calls if c.endswith(".exe")]) == n


def test_updater_installer_mode_uses_setup_asset(tmp_path):
    factory, _ = make_client()
    u = up.Updater("0.1.0", repo="x/y", mode=up.MODE_INSTALLER, cache_dir=tmp_path, client_factory=factory,
                   exe_path=tmp_path / "app.exe")
    st = u.check()
    assert st["state"] == "ready" and st["file"].endswith(up.ASSET_SETUP)


def test_updater_rejects_bad_checksum(tmp_path):
    factory, _ = make_client(bad_sum=True)
    u = up.Updater("0.1.0", repo="x/y", mode=up.MODE_PORTABLE, cache_dir=tmp_path, client_factory=factory,
                   exe_path=tmp_path / "app.exe")
    st = u.check()
    assert st["state"] == "error" and "SHA-256" in st["message"]
    assert not list(tmp_path.rglob("*.exe"))


def test_updater_up_to_date_and_source_mode(tmp_path):
    factory, _ = make_client(version="0.1.0")
    u = up.Updater("0.1.0", repo="x/y", mode=up.MODE_PORTABLE, cache_dir=tmp_path, client_factory=factory)
    assert u.check()["state"] == "none"
    factory2, calls = make_client(version="9.9.9")
    u2 = up.Updater("0.1.0", repo="x/y", mode=up.MODE_SOURCE, cache_dir=tmp_path, client_factory=factory2)
    st = u2.check()
    assert st["state"] == "available" and not st["can_apply"]
    assert not any(c.endswith(".exe") for c in calls)   # 개발 모드는 다운로드하지 않음
    assert "error" in u2.apply()


def test_updater_network_error_is_reported(tmp_path):
    def boom(req):
        raise httpx.ConnectError("offline")
    factory = lambda: httpx.Client(transport=httpx.MockTransport(boom))  # noqa: E731
    u = up.Updater("0.1.0", repo="x/y", mode=up.MODE_PORTABLE, cache_dir=tmp_path, client_factory=factory)
    st = u.check()
    assert st["state"] == "error" and "연결" in st["message"]


def test_apply_builds_detached_command(tmp_path):
    factory, _ = make_client()
    exe = tmp_path / "app.exe"
    u = up.Updater("0.1.0", repo="x/y", mode=up.MODE_PORTABLE, cache_dir=tmp_path, client_factory=factory, exe_path=exe)
    u.check()
    launched = []
    res = u.apply(relaunch=True, launcher=lambda cmd: launched.append(cmd))
    assert res["ok"] and launched
    cmd = launched[0]
    assert cmd[0] == "powershell.exe" and "-File" in cmd and "-Relaunch" in cmd
    script = Path(cmd[cmd.index("-File") + 1])
    assert script.exists() and "Move-Item" in script.read_text(encoding="utf-8-sig")
    assert cmd[cmd.index("-Mode") + 1] == "portable" and cmd[cmd.index("-Exe") + 1] == str(exe)
    assert not u.status()["can_apply"]            # 한 번 적용하면 다시 적용하지 않음
    assert "error" in u.apply(launcher=lambda c: None)


def test_api_update_endpoints(monkeypatch, tmp_path):
    from dronesim import api as api_mod
    a = api_mod.Api()
    factory, _ = make_client()
    a._updater = up.Updater("0.1.0", repo="x/y", mode=up.MODE_PORTABLE, cache_dir=tmp_path, client_factory=factory,
                            exe_path=tmp_path / "app.exe")
    assert a.update_status()["state"] == "idle"
    st = a._updater.check()
    assert st["state"] == "ready"
    s = a.get_settings()
    assert s["auto_update"] is True
    assert a.save_settings({"auto_update": False})["auto_update"] is False
    json.dumps(a.update_status())


def test_launch_detached_strips_pyinstaller_env(monkeypatch):
    monkeypatch.setenv("_PYI_ARCHIVE_FILE", r"C:\x\app.exe")
    monkeypatch.setenv("_PYI_PARENT_PROCESS_LEVEL", "1")
    monkeypatch.setenv("_PYI_APPLICATION_HOME_DIR", r"C:\stale\_MEI123")
    monkeypatch.setenv("_MEIPASS2", r"C:\stale\_MEI123")
    monkeypatch.setenv("KEEP_ME", "1")
    captured = {}

    class FakePopen:
        def __init__(self, cmd, **kw):
            captured["cmd"] = cmd
            captured["env"] = kw.get("env")

    monkeypatch.setattr(up.subprocess, "Popen", FakePopen)
    up.launch_detached(["powershell.exe", "-File", "x.ps1"])
    env = captured["env"]
    assert env is not None and env.get("KEEP_ME") == "1"
    assert not any(k.startswith(("_PYI_", "_MEIPASS")) for k in env)
    assert "Env:" in up.APPLY_SCRIPT and "_PYI_*" in up.APPLY_SCRIPT   # 스크립트도 재실행 전 변수 제거
