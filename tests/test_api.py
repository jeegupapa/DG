import json

import pytest

from dronesim import api as api_mod
from dronesim.weather import WeatherError
from tests.conftest import make_weather


@pytest.fixture
def api(monkeypatch):
    monkeypatch.setattr(api_mod, "fetch_weather", lambda lat, lon, date: make_weather(date=date))
    return api_mod.Api()


def test_profiles_and_info(api):
    ps = api.get_profiles()
    assert {p["id"] for p in ps} == {"quad500", "hexa900"}
    assert all(p["hover_endurance_min"] > 5 for p in ps)
    assert api.app_info()["desktop"] is False


def test_simulate_roundtrip(api, short_mission):
    res = api.simulate(short_mission.to_dict(), n_runs=50)
    assert "error" not in res
    assert res["verdict"] in ("가능", "주의", "불가")
    json.dumps(res, ensure_ascii=False)        # JSON 직렬화 가능


def test_simulate_validation(api, short_mission):
    assert "error" in api.simulate({"waypoints": [], "date": "2026-10-18"})
    bad = {**short_mission.to_dict(), "profile_id": "nope"}
    assert "알 수 없는 기체" in api.simulate(bad)["error"]


def test_simulate_weather_error(monkeypatch, short_mission):
    def boom(lat, lon, date):
        raise WeatherError("예보 범위 밖")
    monkeypatch.setattr(api_mod, "fetch_weather", boom)
    assert api_mod.Api().simulate(short_mission.to_dict())["error"] == "예보 범위 밖"


def test_export_text(api, short_mission):
    for fmt, ext in (("plan", ".plan"), ("waypoints", ".waypoints"), ("json", ".mission.json")):
        res = api.export_mission_text(short_mission.to_dict(), fmt)
        assert res["filename"].endswith(ext) and res["text"]
    assert "error" in api.export_mission_text(short_mission.to_dict(), "kml")


# ---------------------------------------------------------------- 기상 소스 선택·설정
def test_simulate_reports_weather_source(api, short_mission):
    res = api.simulate(short_mission.to_dict(), 50)
    ws = res["weather_source"]
    assert ws["requested"] == "auto" and ws["used"] == "forecast" and "인증키 없음" in ws["note"]
    assert ws["label"] == "Open-Meteo 예보"

    res = api.simulate(short_mission.to_dict(), 50, "open-meteo")
    assert res["weather_source"]["requested"] == "open-meteo" and res["weather_source"]["note"] is None

    assert "인증키" in api.simulate(short_mission.to_dict(), 50, "kma")["error"]
    assert "알 수 없는 기상 소스" in api.simulate(short_mission.to_dict(), 50, "noaa")["error"]


def test_simulate_uses_kma_when_key_present(api, monkeypatch, short_mission):
    monkeypatch.setenv("KMA_SERVICE_KEY", "K")
    monkeypatch.setattr(api_mod, "fetch_weather_by_source",
                        lambda lat, lon, date, source, **kw: make_weather(date=date, source="kma"))
    res = api.simulate(short_mission.to_dict(), 50)
    assert res["weather_source"]["used"] == "kma" and res["weather_source"]["label"] == "기상청 단기예보"


def test_settings_roundtrip(api, isolated_config):
    s = api.get_settings()
    assert s["weather_source"] == "auto" and s["kma_key_set"] is False and s["kma_key_origin"] is None
    assert s["config_path"].startswith(str(isolated_config))

    s = api.save_settings({"weather_source": "kma", "kma_service_key": " MYKEY "})
    assert s["ok"] and s["weather_source"] == "kma" and s["kma_key_set"] and s["kma_key_origin"] == "config"
    saved = json.loads((isolated_config / "config.json").read_text(encoding="utf-8"))
    assert saved == {"weather_source": "kma", "kma_service_key": "MYKEY"}

    s = api.save_settings({"kma_service_key": ""})
    assert s["kma_key_set"] is False
    assert "error" in api.save_settings({"weather_source": "bogus"})


def test_simulate_default_source_from_config(api, short_mission):
    api.save_settings({"weather_source": "open-meteo"})
    res = api.simulate(short_mission.to_dict(), 50)
    assert res["weather_source"]["requested"] == "open-meteo"


def test_check_kma_key_without_key(api):
    assert api.check_kma_key(None)["ok"] is False
