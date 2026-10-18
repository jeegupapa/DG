"""화면(JS)에서 호출하는 Python API. pywebview js_api와 개발용 HTTP 서버가 공유한다."""
from __future__ import annotations

import datetime as dt
import json
import traceback
from dataclasses import asdict
from pathlib import Path
from typing import Any

from . import __version__, config
from .export import mission_planner_waypoints, qgc_plan_text
from .models import MissionInput
from .simulate import evaluate, load_profiles
from .weather import WeatherError, fetch_weather
from .weather_kma import check_kma_key
from .weather_sources import SOURCE_LABELS, fetch_weather_by_source, normalize_source
from .updater import Updater


class Api:
    def __init__(self) -> None:
        # pywebview 창 (파일 대화상자용). 개발 서버에서는 None.
        # 밑줄로 시작해야 pywebview가 JS API로 노출하려고 .NET 창 객체를 재귀 탐색하지 않는다.
        self._window = None
        self._profiles = load_profiles()
        from .updater import REPO as DEFAULT_REPO
        self._updater = Updater(__version__, repo=config.get_update_repo(DEFAULT_REPO))

    # ------------------------------------------------------------ 자동 업데이트
    def update_status(self) -> dict[str, Any]:
        return self._updater.status()

    def check_update(self, download: bool = True) -> dict[str, Any]:
        """백그라운드로 새 버전 확인(및 다운로드)을 시작하고 현재 상태를 돌려준다."""
        self._updater.check_async(bool(download))
        return self._updater.status()

    def apply_update(self) -> dict[str, Any]:
        """준비된 업데이트를 적용한다: 적용 스크립트를 분리 실행한 뒤 창을 닫고, 설치 후 다시 실행된다."""
        res = self._updater.apply(relaunch=True)
        if res.get("ok") and self._window is not None:
            import threading
            threading.Timer(0.5, self._window.destroy).start()
        return res

    def _apply_on_exit(self) -> None:
        """창이 닫힐 때 호출: 자동 적용이 켜져 있고 준비된 업데이트가 있으면 조용히 설치(재실행 없음)."""
        try:
            if config.get_auto_update() and self._updater.status().get("can_apply"):
                self._updater.apply(relaunch=False)
        except Exception:
            pass

    # ------------------------------------------------------------ 조회
    def get_profiles(self) -> list[dict[str, Any]]:
        out = []
        for p in self._profiles.values():
            d = asdict(p)
            d["usable_wh"] = p.usable_wh
            d["hover_endurance_min"] = round(p.hover_endurance_min(), 1)
            out.append(d)
        return out

    def app_info(self) -> dict[str, Any]:
        return {"version": __version__, "today": dt.date.today().isoformat(), "desktop": self._window is not None}

    # ------------------------------------------------------------ 설정 (기상 소스·기상청 인증키)
    def get_settings(self) -> dict[str, Any]:
        origin = config.kma_key_origin()
        return {
            "weather_source": config.get_default_weather_source(),
            "sources": list(config.WEATHER_SOURCES),
            "kma_key_set": origin is not None,
            "kma_key_origin": origin,            # "env" | "config" | None
            "config_path": str(config.config_path()),
            "auto_update": config.get_auto_update(),
        }

    def save_settings(self, settings: dict[str, Any]) -> dict[str, Any]:
        """weather_source 와 kma_service_key 를 설정파일에 저장. kma_service_key="" 는 키 삭제."""
        try:
            changes: dict[str, Any] = {}
            if "weather_source" in settings:
                changes[config.KEY_WEATHER_SOURCE] = normalize_source(settings["weather_source"])
            if "kma_service_key" in settings:
                key = str(settings["kma_service_key"] or "").strip()
                changes[config.KEY_KMA] = key or None
            if "auto_update" in settings:
                changes[config.KEY_AUTO_UPDATE] = bool(settings["auto_update"])
            if changes:
                config.update_config(**changes)
            return {"ok": True, **self.get_settings()}
        except WeatherError as e:
            return {"error": str(e)}
        except OSError as e:
            return {"error": f"설정 파일을 저장할 수 없습니다: {e}"}

    def check_kma_key(self, service_key: str | None = None) -> dict[str, Any]:
        """입력한(또는 저장된) 기상청 인증키로 실제 호출을 시도해 연결 여부를 돌려준다."""
        key = (service_key or "").strip() or None
        return check_kma_key(key)

    # ------------------------------------------------------------ 시뮬레이션
    def simulate(self, mission: dict[str, Any], n_runs: int = 500,
                 weather_source: str | None = None) -> dict[str, Any]:
        """weather_source: "auto" | "kma" | "open-meteo". None 이면 설정파일 기본값(없으면 auto)."""
        try:
            m = MissionInput.from_dict(mission)
            if not m.waypoints:
                return {"error": "지도에서 웨이포인트를 1개 이상 입력하세요."}
            profile = self._profiles.get(m.profile_id)
            if profile is None:
                return {"error": f"알 수 없는 기체 프로필: {m.profile_id}"}
            source = normalize_source(weather_source or config.get_default_weather_source())
            home = m.waypoints[0]
            # fetch_weather 는 모듈 전역을 거쳐 호출해 테스트에서 바꿔 끼울 수 있게 한다.
            weather = fetch_weather_by_source(
                home.lat, home.lon, m.date, source,
                open_meteo_fetch=lambda la, lo, d: fetch_weather(la, lo, d))
            result = evaluate(m, profile, weather, n_runs=int(n_runs))
            result["weather_source"] = {
                "requested": source,
                "used": weather.source,
                "label": SOURCE_LABELS.get(weather.source, weather.source),
                "note": weather.note,
            }
            return result
        except WeatherError as e:
            return {"error": str(e)}
        except Exception as e:  # 화면에 원인 표시
            return {"error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()}

    # ------------------------------------------------------------ 파일
    def _save_dialog(self, filename: str, file_types: tuple[str, ...]) -> str | None:
        if self._window is None:
            return None
        import webview
        res = self._window.create_file_dialog(webview.FileDialog.SAVE, save_filename=filename, file_types=file_types)
        if not res:
            return None
        return res if isinstance(res, str) else res[0]

    def _open_dialog(self, file_types: tuple[str, ...]) -> str | None:
        if self._window is None:
            return None
        import webview
        res = self._window.create_file_dialog(webview.FileDialog.OPEN, allow_multiple=False, file_types=file_types)
        if not res:
            return None
        return res if isinstance(res, str) else res[0]

    def export_mission_text(self, mission: dict[str, Any], fmt: str) -> dict[str, Any]:
        """임무 파일 내용을 문자열로 반환(개발 서버/브라우저 다운로드용)."""
        try:
            m = MissionInput.from_dict(mission)
            profile = self._profiles[m.profile_id]
            if fmt == "plan":
                return {"filename": f"{m.name}.plan", "text": qgc_plan_text(m, profile)}
            if fmt == "waypoints":
                return {"filename": f"{m.name}.waypoints", "text": mission_planner_waypoints(m)}
            if fmt == "json":
                return {"filename": f"{m.name}.mission.json",
                        "text": json.dumps(m.to_dict(), ensure_ascii=False, indent=2)}
            return {"error": f"알 수 없는 형식: {fmt}"}
        except Exception as e:
            return {"error": f"{type(e).__name__}: {e}"}

    def export_mission(self, mission: dict[str, Any], fmt: str) -> dict[str, Any]:
        """저장 대화상자를 열어 임무 파일을 저장(데스크톱 전용)."""
        res = self.export_mission_text(mission, fmt)
        if "error" in res:
            return res
        types = {
            "plan": ("QGroundControl Plan (*.plan)",),
            "waypoints": ("Mission Planner Waypoints (*.waypoints)",),
            "json": ("임무 파일 (*.json)",),
        }[fmt]
        path = self._save_dialog(res["filename"], types)
        if not path:
            return {"cancelled": True}
        Path(path).write_text(res["text"], encoding="utf-8")
        return {"path": path}

    def load_mission(self) -> dict[str, Any]:
        path = self._open_dialog(("임무 파일 (*.json)",))
        if not path:
            return {"cancelled": True}
        try:
            data = json.loads(Path(path).read_text(encoding="utf-8"))
            return {"mission": MissionInput.from_dict(data).to_dict(), "path": path}
        except Exception as e:
            return {"error": f"임무 파일을 읽을 수 없습니다: {e}"}

    def save_report(self, text: str, filename: str = "임무_평가_보고서.txt") -> dict[str, Any]:
        path = self._save_dialog(filename, ("텍스트 보고서 (*.txt)",))
        if not path:
            return {"cancelled": True}
        Path(path).write_text(text, encoding="utf-8")
        return {"path": path}
