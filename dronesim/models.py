"""데이터 모델."""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any


@dataclass
class Waypoint:
    lat: float
    lon: float
    alt_m: float = 50.0
    hover_s: float = 0.0


@dataclass
class MissionInput:
    waypoints: list[Waypoint]
    date: str                      # "YYYY-MM-DD" (현지 날짜)
    time: str                      # "HH:MM" (현지 시각, 출발)
    profile_id: str
    mission_type: str = "촬영"     # 촬영 / 운송 / 순찰 / 측량
    payload_kg: float = 0.0
    return_to_home: bool = True
    vlos: bool = True              # 가시권 운용 여부
    night_approved: bool = False   # 야간 특별비행승인 보유
    gps_risk: bool = False         # GPS 취약 지역(도심 고층, 전파 교란 우려)
    name: str = "임무"

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "MissionInput":
        wps = [Waypoint(float(w["lat"]), float(w["lon"]),
                        float(w.get("alt_m", 50.0)), float(w.get("hover_s", 0.0)))
               for w in d.get("waypoints", [])]
        return MissionInput(
            waypoints=wps,
            date=str(d["date"]),
            time=str(d.get("time", "09:00")),
            profile_id=str(d.get("profile_id", "quad500")),
            mission_type=str(d.get("mission_type", "촬영")),
            payload_kg=float(d.get("payload_kg", 0.0) or 0.0),
            return_to_home=bool(d.get("return_to_home", True)),
            vlos=bool(d.get("vlos", True)),
            night_approved=bool(d.get("night_approved", False)),
            gps_risk=bool(d.get("gps_risk", False)),
            name=str(d.get("name", "임무")),
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class AircraftProfile:
    id: str
    name: str
    frame_class: str
    weight_kg: float
    payload_max_kg: float
    cruise_speed_ms: float
    max_speed_ms: float
    climb_rate_ms: float
    descent_rate_ms: float
    max_wind_ms: float
    max_gust_ms: float
    battery_wh: float
    hover_power_w: float
    drag_k: float                  # 전진 비행 시 전력 증가 계수
    climb_extra_w: float           # 상승 시 추가 전력
    reserve_fraction: float        # 착륙 시 남겨야 할 배터리 비율
    temp_min_c: float
    temp_max_c: float
    rain_ok: bool
    min_visibility_m: float
    telemetry_range_m: float
    max_altitude_m: float
    night_capable: bool
    notes: str = ""

    @property
    def usable_wh(self) -> float:
        return self.battery_wh * (1.0 - self.reserve_fraction)

    def hover_endurance_min(self, payload_kg: float = 0.0, temp_c: float = 20.0) -> float:
        from .simulate import power_scale_for_payload, capacity_factor_for_temp
        p = self.hover_power_w * power_scale_for_payload(self, payload_kg)
        return self.usable_wh * capacity_factor_for_temp(temp_c) / p * 60.0


@dataclass
class WeatherHour:
    time: str                      # "YYYY-MM-DDTHH:MM" 현지시각
    temp_c: float | None
    precip_mm: float | None
    precip_prob: float | None      # % (예보에만 있음)
    visibility_m: float | None     # 예보에만 있음
    cloud_cover: float | None      # %
    gust_ms: float | None
    wind_levels: dict[int, tuple[float, float]] = field(default_factory=dict)  # 고도(m) -> (풍속 m/s, 풍향 deg)

    def wind_at(self, alt_m: float) -> tuple[float, float]:
        """지정 고도의 (풍속, 풍향). 자료 고도 사이는 선형 보간, 범위 밖은 가장 가까운 값."""
        if not self.wind_levels:
            return 0.0, 0.0
        levels = sorted(self.wind_levels)
        if alt_m <= levels[0]:
            return self.wind_levels[levels[0]]
        if alt_m >= levels[-1]:
            return self.wind_levels[levels[-1]]
        for lo, hi in zip(levels, levels[1:]):
            if lo <= alt_m <= hi:
                s0, d0 = self.wind_levels[lo]
                s1, d1 = self.wind_levels[hi]
                t = (alt_m - lo) / (hi - lo)
                speed = s0 + (s1 - s0) * t
                # 풍향은 각도 보간(최단 경로)
                diff = ((d1 - d0 + 540.0) % 360.0) - 180.0
                direction = (d0 + diff * t + 360.0) % 360.0
                return speed, direction
        return self.wind_levels[levels[-1]]


@dataclass
class WeatherDay:
    source: str                    # "forecast" | "archive" (Open-Meteo) | "kma" (기상청 단기예보)
    latitude: float
    longitude: float
    timezone: str
    date: str
    sunrise: str | None            # "YYYY-MM-DDTHH:MM"
    sunset: str | None
    hours: list[WeatherHour]
    note: str | None = None        # 자료 출처 상세·폴백 사유 등 화면 표시용 메모

    def hour(self, index: int) -> WeatherHour:
        index = max(0, min(index, len(self.hours) - 1))
        return self.hours[index]

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        for h in d["hours"]:
            h["wind_levels"] = {str(k): list(v) for k, v in h["wind_levels"].items()}
        return d
