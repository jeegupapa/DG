"""지리 계산: 거리, 방위각, 바람 성분, 지상속도."""
from __future__ import annotations

import math

EARTH_RADIUS_M = 6371008.8


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """두 지점 사이의 대권 거리(m)."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = p2 - p1
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """진북 기준 방위각(0~360도)."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlmb = math.radians(lon2 - lon1)
    x = math.sin(dlmb) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dlmb)
    return (math.degrees(math.atan2(x, y)) + 360.0) % 360.0


def wind_components(wind_speed_ms: float, wind_from_deg: float, track_deg: float) -> tuple[float, float]:
    """진행 방향 기준 바람 성분.

    반환: (along, cross)
      along > 0 : 뒷바람(진행 방향으로 밀어줌), along < 0 : 맞바람
      cross     : 측풍 크기(부호는 좌우 방향)
    기상 자료의 풍향은 '바람이 불어오는 방향'이므로 180도를 더해 진행 벡터로 바꾼다.
    """
    to_rad = math.radians(wind_from_deg + 180.0)
    track_rad = math.radians(track_deg)
    along = wind_speed_ms * math.cos(to_rad - track_rad)
    cross = wind_speed_ms * math.sin(to_rad - track_rad)
    return along, cross


def ground_speed_ms(airspeed_ms: float, along_ms: float, cross_ms: float) -> float | None:
    """측풍을 보정하며 경로를 유지할 때의 지상속도. 유지 불가능하면 None."""
    if airspeed_ms <= abs(cross_ms):
        return None
    gs = math.sqrt(airspeed_ms**2 - cross_ms**2) + along_ms
    return gs if gs > 0 else None
