"""기상 소스 선택: "auto" | "kma" | "open-meteo".

- auto      : 기상청 인증키가 있으면 기상청 단기예보, 실패·범위 밖·키 없음이면 Open-Meteo 로 폴백
- kma       : 기상청만 사용(실패 시 오류)
- open-meteo: Open-Meteo 만 사용(예보/과거 재분석 자동 선택)

결과 WeatherDay.source 는 "kma" | "forecast" | "archive" 이고, 폴백 사유는 WeatherDay.note 에 적힌다.
"""
from __future__ import annotations

import datetime as dt
from typing import Callable

import httpx

from . import weather as om
from . import weather_kma as kma
from .config import WEATHER_SOURCES, get_kma_service_key
from .models import WeatherDay
from .weather import WeatherError

Fetcher = Callable[[float, float, str], WeatherDay]

SOURCE_LABELS = {
    "kma": "기상청 단기예보",
    "forecast": "Open-Meteo 예보",
    "archive": "Open-Meteo 과거 재분석",
}


def normalize_source(source: str | None) -> str:
    s = (source or "auto").strip().lower().replace("_", "-")
    if s in ("openmeteo", "open-meteo", "om"):
        s = "open-meteo"
    if s not in WEATHER_SOURCES:
        raise WeatherError(f"알 수 없는 기상 소스: {source!r} (auto, kma, open-meteo 중 하나)")
    return s


def fetch_weather_by_source(lat: float, lon: float, date: str, source: str | None = "auto", *,
                            service_key: str | None = None, client: httpx.Client | None = None,
                            now: dt.datetime | None = None, today: dt.date | None = None,
                            open_meteo_fetch: Fetcher | None = None, kma_fetch: Fetcher | None = None) -> WeatherDay:
    """선택한 소스로 기상을 가져온다. 테스트·주입용으로 각 소스의 fetch 함수를 바꿀 수 있다."""
    src = normalize_source(source)
    key = service_key or get_kma_service_key()

    def _om(la: float, lo: float, d: str) -> WeatherDay:
        if open_meteo_fetch is not None:
            return open_meteo_fetch(la, lo, d)
        return om.fetch_weather(la, lo, d, client=client, today=today)

    def _kma(la: float, lo: float, d: str) -> WeatherDay:
        if kma_fetch is not None:
            return kma_fetch(la, lo, d)
        return kma.fetch_kma(la, lo, d, service_key=key, client=client, now=now)

    if src == "open-meteo":
        return _om(lat, lon, date)
    if src == "kma":
        return _kma(lat, lon, date)

    # auto
    if not key:
        wd = _om(lat, lon, date)
        wd.note = _join(wd.note, "기상청 인증키 없음 → Open-Meteo 사용")
        return wd
    try:
        return _kma(lat, lon, date)
    except WeatherError as e:
        wd = _om(lat, lon, date)
        wd.note = _join(wd.note, f"기상청 실패 → Open-Meteo 폴백: {e}")
        return wd


def _join(a: str | None, b: str) -> str:
    return f"{a} · {b}" if a else b
