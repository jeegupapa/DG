import datetime as dt

import httpx
import pytest

from dronesim import config
from dronesim.weather import WeatherError
from dronesim.weather_kma import KST
from dronesim.weather_sources import fetch_weather_by_source, normalize_source
from tests.conftest import make_weather
from tests.test_weather import forecast_payload
from tests.test_weather_kma import ok_response, vilage_items

NOW = dt.datetime(2026, 10, 18, 9, 30, tzinfo=KST)
TODAY = NOW.date()
DATE = "2026-10-18"


def test_normalize_source():
    assert normalize_source(None) == "auto" and normalize_source(" KMA ") == "kma"
    assert normalize_source("open_meteo") == "open-meteo" and normalize_source("openmeteo") == "open-meteo"
    with pytest.raises(WeatherError):
        normalize_source("noaa")


def both_services_client(kma_ok=True, hosts=None):
    """Open-Meteo 와 기상청을 호스트로 구분해 응답하는 MockTransport."""
    hosts = hosts if hosts is not None else []

    def handler(request: httpx.Request) -> httpx.Response:
        hosts.append(request.url.host)
        if "open-meteo" in request.url.host:
            return httpx.Response(200, json=forecast_payload(request.url.params["start_date"]))
        if not kma_ok:
            return httpx.Response(200, json={"response": {"header": {"resultCode": "03", "resultMsg": "NO_DATA"}}})
        return ok_response(vilage_items("20261018", range(9, 24)))
    return httpx.Client(transport=httpx.MockTransport(handler)), hosts


def test_auto_without_key_falls_back_to_open_meteo():
    client, hosts = both_services_client()
    wd = fetch_weather_by_source(36.35, 127.38, DATE, "auto", client=client, now=NOW, today=TODAY)
    assert wd.source == "forecast" and "인증키 없음" in wd.note
    assert all("open-meteo" in h for h in hosts)


def test_auto_with_key_uses_kma():
    client, hosts = both_services_client()
    wd = fetch_weather_by_source(36.35, 127.38, DATE, "auto", service_key="K", client=client, now=NOW, today=TODAY)
    assert wd.source == "kma" and hosts == ["apis.data.go.kr", "apis.data.go.kr"]


def test_auto_with_key_falls_back_when_kma_fails():
    client, hosts = both_services_client(kma_ok=False)
    wd = fetch_weather_by_source(36.35, 127.38, DATE, "auto", service_key="K", client=client, now=NOW, today=TODAY)
    assert wd.source == "forecast" and "폴백" in wd.note and "NO_DATA" in wd.note
    assert hosts[0] == "apis.data.go.kr" and "open-meteo" in hosts[-1]


def test_explicit_kma_raises_and_explicit_open_meteo_skips_kma():
    client, hosts = both_services_client(kma_ok=False)
    with pytest.raises(WeatherError, match="NO_DATA"):
        fetch_weather_by_source(36.35, 127.38, DATE, "kma", service_key="K", client=client, now=NOW, today=TODAY)
    with pytest.raises(WeatherError, match="인증키가 없습니다"):
        fetch_weather_by_source(36.35, 127.38, DATE, "kma", client=client, now=NOW, today=TODAY)
    hosts.clear()
    wd = fetch_weather_by_source(36.35, 127.38, DATE, "open-meteo", service_key="K", client=client, now=NOW, today=TODAY)
    assert wd.source == "forecast" and wd.note is None and all("open-meteo" in h for h in hosts)


def test_key_from_config_file_is_used(isolated_config):
    config.update_config(kma_service_key="FILEKEY")
    client, hosts = both_services_client()
    wd = fetch_weather_by_source(36.35, 127.38, DATE, "auto", client=client, now=NOW, today=TODAY)
    assert wd.source == "kma"


def test_injected_fetchers():
    calls = []

    def om(lat, lon, date):
        calls.append("om")
        return make_weather(date=date)

    def kma(lat, lon, date):
        calls.append("kma")
        raise WeatherError("범위 밖")

    wd = fetch_weather_by_source(1, 2, DATE, "auto", service_key="K", open_meteo_fetch=om, kma_fetch=kma)
    assert calls == ["kma", "om"] and "범위 밖" in wd.note
