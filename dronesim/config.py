"""사용자 설정 파일(인증키·기상 소스 기본값).

위치: %APPDATA%\\DroneMissionSim\\config.json (환경변수 DRONESIM_CONFIG_DIR 로 변경 가능).
기상청 인증키는 환경변수 KMA_SERVICE_KEY 가 설정파일보다 우선한다.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

APP_DIR_NAME = "DroneMissionSim"
CONFIG_FILENAME = "config.json"
ENV_KMA_KEY = "KMA_SERVICE_KEY"
ENV_CONFIG_DIR = "DRONESIM_CONFIG_DIR"

KEY_KMA = "kma_service_key"
KEY_WEATHER_SOURCE = "weather_source"
KEY_AUTO_UPDATE = "auto_update"
KEY_UPDATE_REPO = "update_repo"          # 릴리스를 읽을 GitHub 저장소 "owner/name" (공개여야 함)
WEATHER_SOURCES = ("auto", "kma", "open-meteo")


def config_dir() -> Path:
    override = os.environ.get(ENV_CONFIG_DIR)
    if override:
        return Path(override)
    appdata = os.environ.get("APPDATA")
    base = Path(appdata) if appdata else Path.home() / ".config"
    return base / APP_DIR_NAME


def config_path() -> Path:
    return config_dir() / CONFIG_FILENAME


def load_config() -> dict[str, Any]:
    p = config_path()
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_config(data: dict[str, Any]) -> Path:
    p = config_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return p


def update_config(**changes: Any) -> dict[str, Any]:
    """일부 키만 바꾼다. 값이 None 이면 키를 지운다."""
    data = load_config()
    for k, v in changes.items():
        if v is None:
            data.pop(k, None)
        else:
            data[k] = v
    save_config(data)
    return data


def get_kma_service_key() -> str | None:
    """환경변수 → 설정파일 순으로 기상청 인증키를 찾는다. 없으면 None."""
    env = os.environ.get(ENV_KMA_KEY, "").strip()
    if env:
        return env
    v = str(load_config().get(KEY_KMA, "") or "").strip()
    return v or None


def kma_key_origin() -> str | None:
    """인증키 출처: "env" | "config" | None."""
    if os.environ.get(ENV_KMA_KEY, "").strip():
        return "env"
    if str(load_config().get(KEY_KMA, "") or "").strip():
        return "config"
    return None


def get_auto_update() -> bool:
    """업데이트 자동 확인·다운로드·종료 시 적용 여부. 기본값 True."""
    v = load_config().get(KEY_AUTO_UPDATE, True)
    return bool(v) if isinstance(v, bool) else str(v).lower() not in ("0", "false", "no", "off")


def get_update_repo(default: str) -> str:
    v = str(load_config().get(KEY_UPDATE_REPO, "") or "").strip()
    return v if "/" in v else default


def get_default_weather_source() -> str:
    v = str(load_config().get(KEY_WEATHER_SOURCE, "auto") or "auto")
    return v if v in WEATHER_SOURCES else "auto"
