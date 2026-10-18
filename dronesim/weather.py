"""Open-Meteo 기상 수집.

- 최근/미래 날짜: Forecast API (예보, 고도별 풍속 10/80/120/180 m, 시정, 강수확률 포함)
- 오래된 과거 날짜: Archive API (관측 재분석, 풍속 10/100 m, 시정·강수확률 없음)
"""
from __future__ import annotations

import datetime as dt
from typing import Any

import httpx

from .models import WeatherDay, WeatherHour

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"

FORECAST_HOURLY = [
    "temperature_2m", "precipitation", "precipitation_probability", "visibility",
    "cloud_cover", "wind_gusts_10m",
    "wind_speed_10m", "wind_direction_10m",
    "wind_speed_80m", "wind_direction_80m",
    "wind_speed_120m", "wind_direction_120m",
    "wind_speed_180m", "wind_direction_180m",
]
ARCHIVE_HOURLY = [
    "temperature_2m", "precipitation", "cloud_cover", "wind_gusts_10m",
    "wind_speed_10m", "wind_direction_10m",
    "wind_speed_100m", "wind_direction_100m",
]
DAILY = ["sunrise", "sunset"]

ARCHIVE_LAG_DAYS = 7        # 이보다 오래된 날짜는 archive 사용
FORECAST_MAX_AHEAD_DAYS = 15


class WeatherError(RuntimeError):
    pass


def choose_source(date: dt.date, today: dt.date | None = None) -> str:
    today = today or dt.date.today()
    if date < today - dt.timedelta(days=ARCHIVE_LAG_DAYS):
        return "archive"
    if date > today + dt.timedelta(days=FORECAST_MAX_AHEAD_DAYS):
        raise WeatherError(f"예보 범위({FORECAST_MAX_AHEAD_DAYS}일) 밖의 날짜입니다: {date}")
    return "forecast"


def _col(hourly: dict[str, Any], key: str, i: int) -> float | None:
    vals = hourly.get(key)
    if not vals or i >= len(vals):
        return None
    v = vals[i]
    return None if v is None else float(v)


def parse_open_meteo(payload: dict[str, Any], source: str, date: str) -> WeatherDay:
    hourly = payload.get("hourly") or {}
    times = hourly.get("time") or []
    if not times:
        raise WeatherError("기상 응답에 시간별 자료가 없습니다.")

    level_keys = [10, 80, 100, 120, 180]
    hours: list[WeatherHour] = []
    for i, t in enumerate(times):
        if not str(t).startswith(date):
            continue
        levels: dict[int, tuple[float, float]] = {}
        for lv in level_keys:
            s = _col(hourly, f"wind_speed_{lv}m", i)
            d = _col(hourly, f"wind_direction_{lv}m", i)
            if s is not None and d is not None:
                levels[lv] = (s, d)
        hours.append(WeatherHour(
            time=str(t),
            temp_c=_col(hourly, "temperature_2m", i),
            precip_mm=_col(hourly, "precipitation", i),
            precip_prob=_col(hourly, "precipitation_probability", i),
            visibility_m=_col(hourly, "visibility", i),
            cloud_cover=_col(hourly, "cloud_cover", i),
            gust_ms=_col(hourly, "wind_gusts_10m", i),
            wind_levels=levels,
        ))
    if not hours:
        raise WeatherError(f"{date} 자료가 응답에 없습니다.")

    daily = payload.get("daily") or {}
    sunrise = (daily.get("sunrise") or [None])[0]
    sunset = (daily.get("sunset") or [None])[0]
    return WeatherDay(
        source=source,
        latitude=float(payload.get("latitude", 0.0)),
        longitude=float(payload.get("longitude", 0.0)),
        timezone=str(payload.get("timezone", "")),
        date=date,
        sunrise=sunrise,
        sunset=sunset,
        hours=hours,
    )


def fetch_weather(lat: float, lon: float, date: str, *, client: httpx.Client | None = None,
                  today: dt.date | None = None) -> WeatherDay:
    """지정 지점·날짜의 시간별 기상을 가져온다. 네트워크 오류는 WeatherError로 변환."""
    d = dt.date.fromisoformat(date)
    source = choose_source(d, today)
    url = FORECAST_URL if source == "forecast" else ARCHIVE_URL
    params = {
        "latitude": f"{lat:.5f}",
        "longitude": f"{lon:.5f}",
        "hourly": ",".join(FORECAST_HOURLY if source == "forecast" else ARCHIVE_HOURLY),
        "daily": ",".join(DAILY),
        "timezone": "auto",
        "wind_speed_unit": "ms",
        "start_date": date,
        "end_date": date,
    }
    own_client = client is None
    client = client or httpx.Client(timeout=20.0)
    try:
        resp = client.get(url, params=params)
        if resp.status_code != 200:
            try:
                reason = resp.json().get("reason", resp.text)
            except Exception:
                reason = resp.text
            raise WeatherError(f"기상 서비스 오류({resp.status_code}): {reason}")
        return parse_open_meteo(resp.json(), source, date)
    except httpx.HTTPError as e:
        raise WeatherError(f"기상 서비스에 연결할 수 없습니다: {e}") from e
    finally:
        if own_client:
            client.close()
