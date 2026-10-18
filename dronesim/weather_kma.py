"""기상청(공공데이터포털) 단기예보 조회서비스 연동.

- getVilageFcst  : 단기예보. 하루 8회(02,05,08,11,14,17,20,23시) 발표, 발표시각 +1시간부터 약 3일분 1시간 간격
- getUltraSrtFcst: 초단기예보. 매시 30분 발표, +6시간. 당일 자료가 있으면 단기예보 위에 덧씌운다.

응답은 dronesim.models.WeatherDay/WeatherHour 로 정규화한다. 풍속은 10 m 한 레벨만 있으므로
wind_levels={10: (풍속, 풍향)} 이고 돌풍·시정은 None 이다. 일출·일몰은 태양 위치 계산식으로 보강한다.
"""
from __future__ import annotations

import datetime as dt
import math
import re
import xml.etree.ElementTree as ET
from typing import Any
from urllib.parse import unquote

import httpx

from .config import get_kma_service_key
from .models import WeatherDay, WeatherHour
from .weather import WeatherError

KMA_BASE_URL = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0"
VILAGE_ENDPOINT = "getVilageFcst"
ULTRA_ENDPOINT = "getUltraSrtFcst"

KST = dt.timezone(dt.timedelta(hours=9), "Asia/Seoul")
VILAGE_BASE_HOURS = (2, 5, 8, 11, 14, 17, 20, 23)
VILAGE_PUBLISH_DELAY_MIN = 15      # 발표 후 API 제공까지 여유(공식 +10분)
ULTRA_PUBLISH_DELAY_MIN = 45       # 매시 30분 발표, 45분부터 제공
VILAGE_MAX_AHEAD_DAYS = 3
NUM_OF_ROWS = 1000

# 하늘상태 코드(1 맑음, 3 구름많음, 4 흐림) → 운량 %
SKY_TO_CLOUD = {1: 10.0, 3: 60.0, 4: 90.0}

SOURCE_KMA = "kma"


# ---------------------------------------------------------------- 격자 변환 (LCC DFS)
# 기상청 공식 상수
_RE = 6371.00877      # 지구 반경(km)
_GRID = 5.0           # 격자 간격(km)
_SLAT1 = 30.0         # 표준위도 1
_SLAT2 = 60.0         # 표준위도 2
_OLON = 126.0         # 기준점 경도
_OLAT = 38.0          # 기준점 위도
_XO = 43              # 기준점 X 좌표(격자)
_YO = 136             # 기준점 Y 좌표(격자)


def _lcc_params() -> tuple[float, float, float, float]:
    re_ = _RE / _GRID
    slat1 = math.radians(_SLAT1)
    slat2 = math.radians(_SLAT2)
    olat = math.radians(_OLAT)
    sn = math.tan(math.pi * 0.25 + slat2 * 0.5) / math.tan(math.pi * 0.25 + slat1 * 0.5)
    sn = math.log(math.cos(slat1) / math.cos(slat2)) / math.log(sn)
    sf = math.tan(math.pi * 0.25 + slat1 * 0.5)
    sf = sf ** sn * math.cos(slat1) / sn
    ro = math.tan(math.pi * 0.25 + olat * 0.5)
    ro = re_ * sf / ro ** sn
    return re_, sn, sf, ro


def latlon_to_grid(lat: float, lon: float) -> tuple[int, int]:
    """위경도(도) → 기상청 격자 (nx, ny)."""
    re_, sn, sf, ro = _lcc_params()
    ra = math.tan(math.pi * 0.25 + math.radians(lat) * 0.5)
    ra = re_ * sf / ra ** sn
    theta = math.radians(lon) - math.radians(_OLON)
    if theta > math.pi:
        theta -= 2.0 * math.pi
    if theta < -math.pi:
        theta += 2.0 * math.pi
    theta *= sn
    nx = int(math.floor(ra * math.sin(theta) + _XO + 0.5))
    ny = int(math.floor(ro - ra * math.cos(theta) + _YO + 0.5))
    return nx, ny


def grid_to_latlon(nx: int, ny: int) -> tuple[float, float]:
    """기상청 격자 (nx, ny) → 격자점 위경도(도)."""
    re_, sn, sf, ro = _lcc_params()
    xn = nx - _XO
    yn = ro - ny + _YO
    ra = math.sqrt(xn * xn + yn * yn)
    if sn < 0.0:
        ra = -ra
    alat = (re_ * sf / ra) ** (1.0 / sn)
    alat = 2.0 * math.atan(alat) - math.pi * 0.5
    if abs(xn) <= 0.0:
        theta = 0.0
    elif abs(yn) <= 0.0:
        theta = math.pi * 0.5 if xn > 0 else -math.pi * 0.5
    else:
        theta = math.atan2(xn, yn)
    alon = theta / sn + math.radians(_OLON)
    return math.degrees(alat), math.degrees(alon)


# ---------------------------------------------------------------- 일출·일몰 계산
def sunrise_sunset(lat: float, lon: float, date: dt.date, tz_offset_h: float = 9.0) -> tuple[str | None, str | None]:
    """태양 위치 근사식(Almanac for Computers, 미 해군천문대)으로 일출·일몰 현지시각을 구한다.

    반환은 "YYYY-MM-DDTHH:MM" 문자열이며, 극야·백야처럼 해가 뜨지 않거나 지지 않으면 None.
    오차는 보통 ±5분 이내다(주·야간 판정의 30분 여유 안).
    """
    zenith = 90.833
    n = date.timetuple().tm_yday
    lng_hour = lon / 15.0

    def event(rising: bool) -> str | None:
        t = n + (((6.0 if rising else 18.0) - lng_hour) / 24.0)
        m = 0.9856 * t - 3.289
        l = m + 1.916 * math.sin(math.radians(m)) + 0.020 * math.sin(math.radians(2 * m)) + 282.634
        l %= 360.0
        ra = math.degrees(math.atan(0.91764 * math.tan(math.radians(l)))) % 360.0
        ra += (math.floor(l / 90.0) - math.floor(ra / 90.0)) * 90.0
        ra /= 15.0
        sin_dec = 0.39782 * math.sin(math.radians(l))
        cos_dec = math.cos(math.asin(sin_dec))
        cos_h = (math.cos(math.radians(zenith)) - sin_dec * math.sin(math.radians(lat))) / (cos_dec * math.cos(math.radians(lat)))
        if cos_h > 1.0 or cos_h < -1.0:
            return None
        h = (360.0 - math.degrees(math.acos(cos_h))) if rising else math.degrees(math.acos(cos_h))
        h /= 15.0
        tt = h + ra - 0.06571 * t - 6.622
        ut = (tt - lng_hour) % 24.0
        local = (ut + tz_offset_h) % 24.0
        minutes = int(round(local * 60.0))
        hh, mm = divmod(minutes, 60)
        if hh >= 24:
            hh -= 24
        return f"{date.isoformat()}T{hh:02d}:{mm:02d}"

    return event(True), event(False)


# ---------------------------------------------------------------- 값 파서
_NUM_RE = re.compile(r"-?\d+(?:\.\d+)?")


def parse_precip_mm(text: str | None) -> float | None:
    """PCP/RN1 문자열 → mm. '강수없음'→0, '1mm 미만'→0.5, '30.0~50.0mm'→40, '50.0mm 이상'→50, '2.5mm'→2.5."""
    if text is None:
        return None
    s = str(text).strip()
    if not s or s in ("-", "null"):
        return None
    if "없음" in s:
        return 0.0
    nums = [float(x) for x in _NUM_RE.findall(s)]
    if not nums:
        return None
    if "미만" in s:
        return nums[0] / 2.0
    if "~" in s and len(nums) >= 2:
        return (nums[0] + nums[1]) / 2.0
    return nums[0]


def _to_float(text: Any) -> float | None:
    if text is None:
        return None
    try:
        return float(str(text).strip())
    except ValueError:
        return None


def _sky_to_cloud(text: Any) -> float | None:
    v = _to_float(text)
    if v is None:
        return None
    return SKY_TO_CLOUD.get(int(v))


# ---------------------------------------------------------------- 발표시각 선택
def choose_vilage_base(now: dt.datetime) -> tuple[str, str]:
    """현재(KST) 시각 기준 가장 최근에 제공 중인 단기예보 발표 (base_date, base_time)."""
    ref = now - dt.timedelta(minutes=VILAGE_PUBLISH_DELAY_MIN)
    for h in reversed(VILAGE_BASE_HOURS):
        if ref.hour >= h:
            return ref.strftime("%Y%m%d"), f"{h:02d}00"
    prev = ref.date() - dt.timedelta(days=1)
    return prev.strftime("%Y%m%d"), f"{VILAGE_BASE_HOURS[-1]:02d}00"


def choose_ultra_base(now: dt.datetime) -> tuple[str, str]:
    """현재(KST) 시각 기준 가장 최근에 제공 중인 초단기예보 발표 (base_date, base_time)."""
    ref = now - dt.timedelta(minutes=ULTRA_PUBLISH_DELAY_MIN)
    return ref.strftime("%Y%m%d"), f"{ref.hour:02d}30"


# ---------------------------------------------------------------- HTTP
def normalize_service_key(key: str) -> str:
    """공공데이터포털은 Encoding/Decoding 두 가지 키를 보여준다. 어느 쪽을 붙여도 되도록 디코딩해 둔다."""
    key = key.strip()
    if "%" in key:
        key = unquote(key)
    return key


def _parse_error_xml(text: str) -> str | None:
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return None
    code = root.findtext(".//returnReasonCode") or root.findtext(".//resultCode")
    msg = root.findtext(".//returnAuthMsg") or root.findtext(".//errMsg") or root.findtext(".//resultMsg")
    if not (code or msg):
        return None
    return f"{msg or ''} ({code or '?'})".strip()


def _friendly_result(code: str, msg: str) -> str:
    code = str(code)
    if code == "03":
        return "기상청에 해당 격자·발표시각 자료가 없습니다 (NO_DATA)."
    if code in ("30", "31", "32", "33") or "SERVICE_KEY" in msg.upper() or "KEY" in msg.upper():
        return f"기상청 인증키가 거부되었습니다: {msg} ({code}). 공공데이터포털에서 활용신청 승인 여부와 키를 확인하세요."
    if code == "22":
        return f"기상청 API 일일 호출 한도를 초과했습니다: {msg} ({code})"
    return f"기상청 API 오류: {msg} ({code})"


def _request_items(client: httpx.Client, endpoint: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    """단기예보 API를 호출해 item 목록을 모두(페이지 포함) 돌려준다."""
    url = f"{KMA_BASE_URL}/{endpoint}"
    items: list[dict[str, Any]] = []
    page = 1
    while True:
        q = {**params, "pageNo": page, "numOfRows": NUM_OF_ROWS, "dataType": "JSON"}
        resp = client.get(url, params=q)
        if resp.status_code != 200:
            raise WeatherError(f"기상청 서비스 오류(HTTP {resp.status_code}): {resp.text[:200]}")
        try:
            data = resp.json()
        except ValueError:
            reason = _parse_error_xml(resp.text) or resp.text[:200]
            if "KEY" in reason.upper() or "(30)" in reason or "(31)" in reason:
                raise WeatherError(f"기상청 인증키가 거부되었습니다: {reason}. 공공데이터포털에서 활용신청 승인 여부와 키를 확인하세요.")
            raise WeatherError(f"기상청 응답을 해석할 수 없습니다: {reason}")
        header = (data.get("response") or {}).get("header") or {}
        code = str(header.get("resultCode", ""))
        if code != "00":
            raise WeatherError(_friendly_result(code, str(header.get("resultMsg", ""))))
        body = (data.get("response") or {}).get("body") or {}
        raw = (body.get("items") or {}).get("item") or []
        if isinstance(raw, dict):
            raw = [raw]
        items.extend(raw)
        total = int(body.get("totalCount") or len(items))
        if len(items) >= total or not raw:
            break
        page += 1
    return items


def group_by_hour(items: list[dict[str, Any]], date: str) -> dict[int, dict[str, str]]:
    """item 목록 중 fcstDate==date 인 것을 {시(0~23): {category: value}} 로 묶는다."""
    ymd = date.replace("-", "")
    out: dict[int, dict[str, str]] = {}
    for it in items:
        if str(it.get("fcstDate")) != ymd:
            continue
        try:
            hour = int(str(it.get("fcstTime", ""))[:2])
        except ValueError:
            continue
        if not 0 <= hour <= 23:
            continue
        out.setdefault(hour, {})[str(it.get("category"))] = str(it.get("fcstValue"))
    return out


def _hour_from_categories(date: str, hour: int, c: dict[str, str]) -> WeatherHour:
    temp = _to_float(c.get("TMP", c.get("T1H")))
    wsd = _to_float(c.get("WSD"))
    vec = _to_float(c.get("VEC"))
    levels: dict[int, tuple[float, float]] = {}
    if wsd is not None:
        levels[10] = (wsd, vec if vec is not None else 0.0)
    precip = parse_precip_mm(c.get("PCP", c.get("RN1")))
    pty = _to_float(c.get("PTY"))
    if precip is None and pty is not None and pty == 0:
        precip = 0.0
    return WeatherHour(
        time=f"{date}T{hour:02d}:00",
        temp_c=temp,
        precip_mm=precip,
        precip_prob=_to_float(c.get("POP")),
        visibility_m=None,
        cloud_cover=_sky_to_cloud(c.get("SKY")),
        gust_ms=None,
        wind_levels=levels,
    )


def build_weather_day(lat: float, lon: float, date: str, vilage: dict[int, dict[str, str]],
                      ultra: dict[int, dict[str, str]] | None = None, *, note: str = "") -> WeatherDay:
    """시각별 카테고리 묶음 → WeatherDay. 초단기 값이 있으면 그 시각의 TMP/WSD/VEC/PCP/SKY를 덮어쓴다.

    예보가 없는 시각(발표 전 시각 등)은 가장 가까운 시각 자료로 채워 24개를 보장한다.
    """
    merged: dict[int, dict[str, str]] = {h: dict(v) for h, v in vilage.items()}
    ultra_hours = 0
    for h, u in (ultra or {}).items():
        base = merged.setdefault(h, {})
        for src, dst in (("T1H", "TMP"), ("WSD", "WSD"), ("VEC", "VEC"), ("RN1", "PCP"), ("SKY", "SKY"), ("PTY", "PTY")):
            if src in u:
                base[dst] = u[src]
        ultra_hours += 1
    if not merged:
        raise WeatherError(f"기상청 단기예보에 {date} 자료가 없습니다 (예보 범위는 발표일 기준 +{VILAGE_MAX_AHEAD_DAYS}일).")

    available = sorted(merged)
    filled: list[int] = []
    hours: list[WeatherHour] = []
    for h in range(24):
        if h in merged:
            src_h = h
        else:
            src_h = min(available, key=lambda a: (abs(a - h), a))
            filled.append(h)
        hours.append(_hour_from_categories(date, h, merged[src_h]))

    d = dt.date.fromisoformat(date)
    sunrise, sunset = sunrise_sunset(lat, lon, d)
    parts = [p for p in (note,) if p]
    if ultra_hours:
        parts.append(f"초단기예보 {ultra_hours}시간 반영")
    if filled:
        parts.append(f"예보 미제공 {len(filled)}시각({filled[0]:02d}~{filled[-1]:02d}시)은 인접 시각 자료로 대체")
    parts.append("돌풍·시정 자료 없음")
    return WeatherDay(
        source=SOURCE_KMA,
        latitude=float(lat),
        longitude=float(lon),
        timezone="Asia/Seoul",
        date=date,
        sunrise=sunrise,
        sunset=sunset,
        hours=hours,
        note=" · ".join(parts),
    )


def fetch_kma(lat: float, lon: float, date: str, *, service_key: str | None = None,
              client: httpx.Client | None = None, now: dt.datetime | None = None) -> WeatherDay:
    """기상청 단기예보(+당일 초단기예보)로 지정 지점·날짜의 시간별 기상을 가져온다.

    인증키가 없거나 날짜가 예보 범위 밖이면 WeatherError.
    """
    key = service_key or get_kma_service_key()
    if not key:
        raise WeatherError("기상청 인증키가 없습니다. 환경변수 KMA_SERVICE_KEY 또는 설정에서 인증키를 입력하세요.")
    key = normalize_service_key(key)

    now = now or dt.datetime.now(KST)
    if now.tzinfo is None:
        now = now.replace(tzinfo=KST)
    now = now.astimezone(KST)
    today = now.date()
    d = dt.date.fromisoformat(date)
    if d > today + dt.timedelta(days=VILAGE_MAX_AHEAD_DAYS):
        raise WeatherError(f"기상청 단기예보 범위(+{VILAGE_MAX_AHEAD_DAYS}일) 밖의 날짜입니다: {date}")

    nx, ny = latlon_to_grid(lat, lon)
    if d < today:
        # 과거 날짜: 그날 02시 발표분(하루 전체 거의 포함). 보관 기간을 넘으면 NO_DATA.
        base_date, base_time = d.strftime("%Y%m%d"), f"{VILAGE_BASE_HOURS[0]:02d}00"
    else:
        base_date, base_time = choose_vilage_base(now)

    common = {"serviceKey": key, "nx": nx, "ny": ny}
    own_client = client is None
    client = client or httpx.Client(timeout=20.0)
    try:
        try:
            items = _request_items(client, VILAGE_ENDPOINT, {**common, "base_date": base_date, "base_time": base_time})
        except httpx.HTTPError as e:
            raise WeatherError(f"기상청 서비스에 연결할 수 없습니다: {e}") from e
        vilage = group_by_hour(items, date)
        if not vilage:
            raise WeatherError(f"기상청 단기예보({base_date} {base_time[:2]}시 발표)에 {date} 자료가 없습니다.")

        ultra: dict[int, dict[str, str]] | None = None
        ultra_note = ""
        if d == today or d == today + dt.timedelta(days=1):
            ub_date, ub_time = choose_ultra_base(now)
            try:
                uitems = _request_items(client, ULTRA_ENDPOINT, {**common, "base_date": ub_date, "base_time": ub_time})
                ultra = group_by_hour(uitems, date) or None
            except (WeatherError, httpx.HTTPError) as e:   # 초단기는 보조 자료: 실패해도 단기예보로 진행
                ultra_note = f"초단기예보 생략({str(e)[:60]})"
    finally:
        if own_client:
            client.close()

    note = f"기상청 단기예보 격자 ({nx},{ny}) · 발표 {base_date[:4]}-{base_date[4:6]}-{base_date[6:]} {base_time[:2]}:{base_time[2:]}"
    if ultra_note:
        note += " · " + ultra_note
    return build_weather_day(lat, lon, date, vilage, ultra, note=note)


def check_kma_key(service_key: str | None = None, *, client: httpx.Client | None = None,
                  now: dt.datetime | None = None) -> dict[str, Any]:
    """인증키 연결 확인: 서울 격자 초단기예보를 소량 조회한다. {"ok": bool, "message": str}."""
    key = service_key or get_kma_service_key()
    if not key:
        return {"ok": False, "message": "인증키가 없습니다."}
    now = now or dt.datetime.now(KST)
    if now.tzinfo is None:
        now = now.replace(tzinfo=KST)
    now = now.astimezone(KST)
    base_date, base_time = choose_ultra_base(now)
    own_client = client is None
    client = client or httpx.Client(timeout=15.0)
    try:
        items = _request_items(client, ULTRA_ENDPOINT, {
            "serviceKey": normalize_service_key(key), "nx": 60, "ny": 127,
            "base_date": base_date, "base_time": base_time,
        })
        return {"ok": True, "message": f"연결 성공 · 초단기예보 {len(items)}건 수신 ({base_date} {base_time})"}
    except WeatherError as e:
        return {"ok": False, "message": str(e)}
    except httpx.HTTPError as e:
        return {"ok": False, "message": f"기상청 서비스에 연결할 수 없습니다: {e}"}
    finally:
        if own_client:
            client.close()
