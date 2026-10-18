import datetime as dt

import httpx
import pytest

from dronesim.weather import (ARCHIVE_URL, FORECAST_URL, WeatherError, choose_source, fetch_weather,
                              parse_open_meteo)

TODAY = dt.date(2026, 10, 18)


def test_choose_source():
    assert choose_source(TODAY, TODAY) == "forecast"
    assert choose_source(TODAY - dt.timedelta(days=3), TODAY) == "forecast"
    assert choose_source(TODAY - dt.timedelta(days=30), TODAY) == "archive"
    assert choose_source(TODAY + dt.timedelta(days=10), TODAY) == "forecast"
    with pytest.raises(WeatherError):
        choose_source(TODAY + dt.timedelta(days=40), TODAY)


def forecast_payload(date="2026-10-18"):
    n = 24
    times = [f"{date}T{h:02d}:00" for h in range(n)]
    return {
        "latitude": 36.35, "longitude": 127.38, "timezone": "Asia/Seoul",
        "hourly": {
            "time": times,
            "temperature_2m": [15.0 + h * 0.2 for h in range(n)],
            "precipitation": [0.0] * n,
            "precipitation_probability": [5.0] * n,
            "visibility": [24140.0] * n,
            "cloud_cover": [10.0] * n,
            "wind_gusts_10m": [6.0] * n,
            "wind_speed_10m": [3.0] * n, "wind_direction_10m": [270.0] * n,
            "wind_speed_80m": [5.0] * n, "wind_direction_80m": [280.0] * n,
            "wind_speed_120m": [6.0] * n, "wind_direction_120m": [285.0] * n,
            "wind_speed_180m": [7.0] * n, "wind_direction_180m": [290.0] * n,
        },
        "daily": {"time": [date], "sunrise": [f"{date}T06:45"], "sunset": [f"{date}T17:55"]},
    }


def test_parse_forecast():
    wd = parse_open_meteo(forecast_payload(), "forecast", "2026-10-18")
    assert len(wd.hours) == 24
    assert wd.sunrise == "2026-10-18T06:45"
    h = wd.hours[9]
    assert h.visibility_m == 24140.0 and h.precip_prob == 5.0
    assert set(h.wind_levels) == {10, 80, 120, 180}
    # 보간: 10 m(3.0)와 80 m(5.0) 사이 45 m → 4.0
    spd, _ = h.wind_at(45.0)
    assert abs(spd - 4.0) < 1e-9
    # 범위 밖은 가장 가까운 값
    assert h.wind_at(5.0)[0] == 3.0
    assert h.wind_at(500.0)[0] == 7.0


def test_parse_requires_date_rows():
    with pytest.raises(WeatherError):
        parse_open_meteo(forecast_payload("2026-10-17"), "forecast", "2026-10-18")


def test_fetch_uses_forecast_and_archive_urls():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        date = request.url.params["start_date"]
        payload = forecast_payload(date)
        if "archive" in str(request.url):
            for k in ("precipitation_probability", "visibility"):
                payload["hourly"].pop(k)
        return httpx.Response(200, json=payload)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    wd = fetch_weather(36.35, 127.38, "2026-10-18", client=client, today=TODAY)
    assert wd.source == "forecast" and seen[-1].startswith(FORECAST_URL)
    assert "wind_speed_unit=ms" in seen[-1]

    wd2 = fetch_weather(36.35, 127.38, "2026-08-01", client=client, today=TODAY)
    assert wd2.source == "archive" and seen[-1].startswith(ARCHIVE_URL)
    assert wd2.hours[0].visibility_m is None


def test_fetch_error_becomes_weather_error():
    def handler(request):
        return httpx.Response(400, json={"error": True, "reason": "bad coords"})
    client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(WeatherError, match="bad coords"):
        fetch_weather(0, 0, "2026-10-18", client=client, today=TODAY)
