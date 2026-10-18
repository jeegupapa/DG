import datetime as dt
import json

import httpx
import pytest

from dronesim import config
from dronesim.weather import WeatherError
from dronesim.weather_kma import (KMA_BASE_URL, KST, build_weather_day, check_kma_key, choose_ultra_base,
                                  choose_vilage_base, fetch_kma, grid_to_latlon, group_by_hour, latlon_to_grid,
                                  normalize_service_key, parse_precip_mm, sunrise_sunset)

NOW = dt.datetime(2026, 10, 18, 9, 30, tzinfo=KST)   # 토요일 09:30 KST → 단기 08시 발표, 초단기 08:30 발표
DATE = "2026-10-18"


# ---------------------------------------------------------------- 격자 변환
@pytest.mark.parametrize("lat,lon,nx,ny", [
    (37.5665, 126.9780, 60, 127),    # 서울
    (35.1798, 129.0750, 98, 76),     # 부산
    (36.3504, 127.3845, 67, 100),    # 대전
    (33.4996, 126.5312, 53, 38),     # 제주
])
def test_latlon_to_grid_matches_kma_table(lat, lon, nx, ny):
    assert latlon_to_grid(lat, lon) == (nx, ny)


def test_grid_roundtrip():
    for nx, ny in [(60, 127), (67, 100), (98, 76), (53, 38)]:
        lat, lon = grid_to_latlon(nx, ny)
        assert latlon_to_grid(lat, lon) == (nx, ny)
    # 격자점 위경도는 원점 근처여야 한다 (격자 5 km → 0.05도 이내)
    lat, lon = grid_to_latlon(60, 127)
    assert abs(lat - 37.5665) < 0.05 and abs(lon - 126.978) < 0.05


# ---------------------------------------------------------------- 일출·일몰
def _minutes(s: str) -> int:
    return int(s[11:13]) * 60 + int(s[14:16])


def test_sunrise_sunset_seoul():
    sr, ss = sunrise_sunset(37.5665, 126.978, dt.date(2026, 6, 21))
    assert sr.startswith("2026-06-21T") and abs(_minutes(sr) - (5 * 60 + 11)) <= 6
    assert abs(_minutes(ss) - (19 * 60 + 57)) <= 6
    sr, ss = sunrise_sunset(37.5665, 126.978, dt.date(2026, 12, 22))
    assert abs(_minutes(sr) - (7 * 60 + 43)) <= 6 and abs(_minutes(ss) - (17 * 60 + 17)) <= 6


def test_sunrise_polar_night_is_none():
    sr, ss = sunrise_sunset(78.0, 15.0, dt.date(2026, 12, 22), tz_offset_h=1)
    assert sr is None and ss is None


# ---------------------------------------------------------------- 파서·발표시각
def test_parse_precip():
    assert parse_precip_mm("강수없음") == 0.0
    assert parse_precip_mm("1mm 미만") == 0.5
    assert parse_precip_mm("1.0mm 미만") == 0.5
    assert parse_precip_mm("30.0~50.0mm") == 40.0
    assert parse_precip_mm("50.0mm 이상") == 50.0
    assert parse_precip_mm("2.5mm") == 2.5
    assert parse_precip_mm("-") is None and parse_precip_mm(None) is None


def test_choose_base_times():
    assert choose_vilage_base(dt.datetime(2026, 10, 18, 5, 5, tzinfo=KST)) == ("20261018", "0200")
    assert choose_vilage_base(dt.datetime(2026, 10, 18, 5, 20, tzinfo=KST)) == ("20261018", "0500")
    assert choose_vilage_base(dt.datetime(2026, 10, 18, 1, 0, tzinfo=KST)) == ("20261017", "2300")
    assert choose_vilage_base(dt.datetime(2026, 10, 18, 23, 59, tzinfo=KST)) == ("20261018", "2300")
    assert choose_ultra_base(dt.datetime(2026, 10, 18, 10, 40, tzinfo=KST)) == ("20261018", "0930")
    assert choose_ultra_base(dt.datetime(2026, 10, 18, 10, 50, tzinfo=KST)) == ("20261018", "1030")
    assert choose_ultra_base(dt.datetime(2026, 10, 18, 0, 10, tzinfo=KST)) == ("20261017", "2330")


def test_normalize_service_key_accepts_encoded():
    raw = "abc+def/ghi=="
    assert normalize_service_key(raw) == raw
    assert normalize_service_key("abc%2Bdef%2Fghi%3D%3D") == raw


# ---------------------------------------------------------------- 응답 고정(MockTransport)
def vilage_items(date_ymd: str, hours, base_time="0800"):
    items = []
    for h in hours:
        vals = {"TMP": f"{10 + h * 0.5:.0f}", "WSD": f"{2 + h * 0.1:.1f}", "VEC": str((h * 15) % 360),
                "POP": "30" if h < 15 else "70", "PCP": "강수없음" if h < 15 else "1.0mm",
                "SKY": "1" if h < 12 else "4", "REH": "60", "PTY": "0"}
        for cat, v in vals.items():
            items.append({"baseDate": date_ymd, "baseTime": base_time, "category": cat,
                          "fcstDate": date_ymd, "fcstTime": f"{h:02d}00", "fcstValue": v, "nx": 67, "ny": 100})
    return items


def ultra_items(date_ymd: str, hours, base_time="0830"):
    items = []
    for h in hours:
        vals = {"T1H": "99", "WSD": "9.9", "VEC": "180", "RN1": "3.0mm", "SKY": "3", "PTY": "1", "REH": "80"}
        for cat, v in vals.items():
            items.append({"baseDate": date_ymd, "baseTime": base_time, "category": cat,
                          "fcstDate": date_ymd, "fcstTime": f"{h:02d}00", "fcstValue": v, "nx": 67, "ny": 100})
    return items


def ok_response(items, total=None):
    return httpx.Response(200, json={"response": {
        "header": {"resultCode": "00", "resultMsg": "NORMAL_SERVICE"},
        "body": {"dataType": "JSON", "items": {"item": items}, "pageNo": 1, "numOfRows": 1000,
                 "totalCount": total if total is not None else len(items)},
    }})


def make_client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_fetch_kma_builds_full_day_with_ultra_override():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        p = request.url.params
        assert p["serviceKey"] == "TESTKEY" and p["dataType"] == "JSON"
        assert (p["nx"], p["ny"]) == ("67", "100")
        if request.url.path.endswith("getVilageFcst"):
            assert (p["base_date"], p["base_time"]) == ("20261018", "0800")
            # 단기예보는 발표 +1시간(09시)부터 이틀치
            items = vilage_items("20261018", range(9, 24)) + vilage_items("20261019", range(0, 24))
            return ok_response(items)
        assert request.url.path.endswith("getUltraSrtFcst")
        assert (p["base_date"], p["base_time"]) == ("20261018", "0830")
        return ok_response(ultra_items("20261018", range(9, 15)))

    wd = fetch_kma(36.3504, 127.3845, DATE, service_key="TESTKEY", client=make_client(handler), now=NOW)
    assert len(seen) == 2
    assert wd.source == "kma" and wd.timezone == "Asia/Seoul" and wd.date == DATE
    assert len(wd.hours) == 24 and [h.time for h in wd.hours][:2] == [f"{DATE}T00:00", f"{DATE}T01:00"]
    # 09시 이전은 가장 가까운 09시 자료로 채워짐
    assert wd.hours[3].wind_levels == wd.hours[9].wind_levels
    assert "인접 시각 자료로 대체" in wd.note and "격자 (67,100)" in wd.note
    # 초단기(09~14시)가 단기 TMP/WSD/VEC/PCP/SKY를 덮어씀, POP은 단기 유지
    h = wd.hours[10]
    assert h.temp_c == 99.0 and h.wind_levels == {10: (9.9, 180.0)} and h.precip_mm == 3.0
    assert h.cloud_cover == 60.0 and h.precip_prob == 30.0
    # 초단기 범위 밖(16시)은 단기 그대로
    h16 = wd.hours[16]
    assert h16.temp_c == 18.0 and h16.wind_levels == {10: (3.6, 240.0)}
    assert h16.precip_mm == 1.0 and h16.precip_prob == 70.0 and h16.cloud_cover == 90.0
    # 돌풍·시정 없음, 한 레벨 바람은 모든 고도에 동일 적용
    assert h16.gust_ms is None and h16.visibility_m is None
    assert h16.wind_at(120.0) == (3.6, 240.0)
    # 일출·일몰 계산식 보강
    assert wd.sunrise.startswith(DATE + "T06:") and wd.sunset.startswith(DATE + "T17:")
    assert json.dumps(wd.to_dict(), ensure_ascii=False)


def test_fetch_kma_ultra_failure_is_non_fatal():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("getVilageFcst"):
            return ok_response(vilage_items("20261018", range(9, 24)))
        return httpx.Response(500, text="boom")

    wd = fetch_kma(36.3504, 127.3845, DATE, service_key="K", client=make_client(handler), now=NOW)
    assert wd.source == "kma" and wd.hours[10].temp_c == 15.0
    assert "초단기예보 생략" in wd.note


def test_fetch_kma_tomorrow_uses_latest_base_and_paginates():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        p = request.url.params
        calls.append((request.url.path.rsplit("/", 1)[-1], p.get("pageNo")))
        items = vilage_items("20261019", range(0, 24))
        if request.url.path.endswith("getVilageFcst"):
            half = len(items) // 2
            page = int(p["pageNo"])
            return ok_response(items[(page - 1) * half: page * half], total=len(items))
        return ok_response([])

    wd = fetch_kma(36.35, 127.38, "2026-10-19", service_key="K", client=make_client(handler), now=NOW)
    assert ("getVilageFcst", "1") in calls and ("getVilageFcst", "2") in calls
    assert len(wd.hours) == 24 and wd.hours[0].temp_c == 10.0 and wd.hours[23].temp_c == 22.0
    assert "대체" not in wd.note


def test_fetch_kma_past_date_uses_0200_base():
    def handler(request: httpx.Request) -> httpx.Response:
        p = request.url.params
        assert (p["base_date"], p["base_time"]) == ("20261016", "0200")
        return ok_response(vilage_items("20261016", range(3, 24)))

    wd = fetch_kma(36.35, 127.38, "2026-10-16", service_key="K", client=make_client(handler), now=NOW)
    assert wd.date == "2026-10-16" and len(wd.hours) == 24


def test_fetch_kma_out_of_range_and_missing_rows():
    with pytest.raises(WeatherError, match="범위"):
        fetch_kma(36.35, 127.38, "2026-10-25", service_key="K", client=make_client(lambda r: ok_response([])), now=NOW)

    def handler(request: httpx.Request) -> httpx.Response:
        return ok_response(vilage_items("20261018", range(9, 24)))   # 10/21 자료 없음
    with pytest.raises(WeatherError, match="자료가 없습니다"):
        fetch_kma(36.35, 127.38, "2026-10-21", service_key="K", client=make_client(handler), now=NOW)


def test_fetch_kma_errors():
    with pytest.raises(WeatherError, match="인증키가 없습니다"):
        fetch_kma(36.35, 127.38, DATE, client=make_client(lambda r: ok_response([])), now=NOW)

    def no_data(request):
        return httpx.Response(200, json={"response": {"header": {"resultCode": "03", "resultMsg": "NO_DATA"}}})
    with pytest.raises(WeatherError, match="NO_DATA"):
        fetch_kma(36.35, 127.38, DATE, service_key="K", client=make_client(no_data), now=NOW)

    def bad_key(request):
        return httpx.Response(200, text=(
            "<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg>"
            "<returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg>"
            "<returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>"))
    with pytest.raises(WeatherError, match="인증키가 거부"):
        fetch_kma(36.35, 127.38, DATE, service_key="K", client=make_client(bad_key), now=NOW)

    def quota(request):
        return httpx.Response(200, json={"response": {"header": {"resultCode": "22", "resultMsg": "LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR"}}})
    with pytest.raises(WeatherError, match="한도"):
        fetch_kma(36.35, 127.38, DATE, service_key="K", client=make_client(quota), now=NOW)

    def down(request):
        raise httpx.ConnectError("offline")
    with pytest.raises(WeatherError, match="연결할 수 없습니다"):
        fetch_kma(36.35, 127.38, DATE, service_key="K", client=make_client(down), now=NOW)


def test_group_and_build_without_network():
    grouped = group_by_hour(vilage_items("20261018", [6, 7]), DATE)
    assert set(grouped) == {6, 7} and grouped[6]["TMP"] == "13"
    wd = build_weather_day(36.35, 127.38, DATE, grouped)
    assert len(wd.hours) == 24 and wd.hours[0].temp_c == 13.0 and wd.hours[23].temp_c == 14.0
    with pytest.raises(WeatherError):
        build_weather_day(36.35, 127.38, DATE, {})


def test_check_kma_key():
    def handler(request):
        assert request.url.path.endswith("getUltraSrtFcst") and request.url.params["serviceKey"] == "K"
        return ok_response(ultra_items("20261018", [9]))
    res = check_kma_key("K", client=make_client(handler), now=NOW)
    assert res["ok"] and "연결 성공" in res["message"]
    assert check_kma_key(None, client=make_client(handler), now=NOW)["ok"] is False
    bad = check_kma_key("K", client=make_client(lambda r: httpx.Response(200, json={"response": {"header": {"resultCode": "30", "resultMsg": "SERVICE_KEY_IS_NOT_REGISTERED_ERROR"}}})), now=NOW)
    assert bad["ok"] is False and "인증키" in bad["message"]


# ---------------------------------------------------------------- 설정 파일
def test_config_key_lookup(monkeypatch, isolated_config):
    assert config.config_path() == isolated_config / "config.json"
    assert config.get_kma_service_key() is None and config.kma_key_origin() is None
    config.update_config(kma_service_key="FROMFILE", weather_source="kma")
    assert config.get_kma_service_key() == "FROMFILE" and config.kma_key_origin() == "config"
    assert config.get_default_weather_source() == "kma"
    monkeypatch.setenv("KMA_SERVICE_KEY", "FROMENV")
    assert config.get_kma_service_key() == "FROMENV" and config.kma_key_origin() == "env"
    monkeypatch.delenv("KMA_SERVICE_KEY")
    config.update_config(kma_service_key=None)
    assert config.get_kma_service_key() is None
    assert json.loads(config.config_path().read_text(encoding="utf-8")) == {"weather_source": "kma"}
