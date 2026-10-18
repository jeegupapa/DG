"""임무 시뮬레이션: 구간별 소요시간·전력 계산, 항목별 판정, 몬테카를로 성공 확률."""
from __future__ import annotations

import datetime as dt
import json
import math
import random
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

from . import hardware
from .geo import bearing_deg, ground_speed_ms, haversine_m, wind_components
from .models import AircraftProfile, MissionInput, WeatherDay, WeatherHour, Waypoint

_PROFILES_PATH = Path(__file__).resolve().parent / "data" / "profiles.json"

OK, WARN, FAIL, INFO = "ok", "warn", "fail", "info"
_ORDER = {OK: 0, INFO: 0, WARN: 1, FAIL: 2}


# ---------------------------------------------------------------- 프로필

def load_profiles(path: Path | None = None) -> dict[str, AircraftProfile]:
    with open(path or _PROFILES_PATH, encoding="utf-8") as f:
        raw = json.load(f)
    return {p["id"]: AircraftProfile(**p) for p in raw}


# ---------------------------------------------------------------- 물리 모델

def power_scale_for_payload(profile: AircraftProfile, payload_kg: float) -> float:
    """중량 증가에 따른 호버 전력 비율 (P ∝ W^1.5)."""
    if profile.weight_kg <= 0:
        return 1.0
    return ((profile.weight_kg + max(0.0, payload_kg)) / profile.weight_kg) ** 1.5


def capacity_factor_for_temp(temp_c: float | None) -> float:
    """기온에 따른 가용 배터리 용량 비율. 15°C 이상 1.0, -10°C에서 0.75."""
    if temp_c is None:
        return 1.0
    if temp_c >= 15.0:
        return 1.0 if temp_c <= 40.0 else max(0.9, 1.0 - (temp_c - 40.0) * 0.01)
    return max(0.6, 1.0 - (15.0 - temp_c) * 0.01)


def cruise_power_w(profile: AircraftProfile, airspeed_ms: float, payload_kg: float) -> float:
    base = profile.hover_power_w * power_scale_for_payload(profile, payload_kg)
    ratio = airspeed_ms / profile.max_speed_ms if profile.max_speed_ms > 0 else 0.0
    return base * (1.0 + profile.drag_k * ratio * ratio)


# ---------------------------------------------------------------- 결과 구조

@dataclass
class Perturbation:
    wind_scale: float = 1.0
    wind_add_ms: float = 0.0
    gust_scale: float = 1.0
    temp_add_c: float = 0.0
    battery_factor: float = 1.0
    power_factor: float = 1.0
    rain_happens: bool | None = None   # None이면 예보값 그대로 사용


@dataclass
class Segment:
    kind: str                 # takeoff / leg / hover / return / land
    label: str
    distance_m: float
    time_s: float
    energy_wh: float
    start_s: float
    ground_speed_ms: float | None = None
    wind_speed_ms: float = 0.0
    wind_dir_deg: float = 0.0
    along_ms: float = 0.0
    cross_ms: float = 0.0
    status: str = OK
    note: str = ""


@dataclass
class Check:
    key: str
    title: str
    status: str
    value: str
    limit: str
    message: str


@dataclass
class MissionRun:
    segments: list[Segment]
    checks: list[Check]
    total_time_s: float
    total_distance_m: float
    total_energy_wh: float
    usable_wh: float
    battery_used_frac: float
    max_dist_home_m: float
    max_alt_m: float
    start_time: str
    end_time: str
    overall: str
    failures: list[str] = field(default_factory=list)


def _parse_local(date: str, time: str) -> dt.datetime:
    hh, mm = time.split(":")[:2]
    return dt.datetime.fromisoformat(date).replace(hour=int(hh), minute=int(mm))


def _parse_iso_minute(s: str | None) -> dt.datetime | None:
    if not s:
        return None
    try:
        return dt.datetime.fromisoformat(s[:16])
    except ValueError:
        return None


# ---------------------------------------------------------------- 단일 실행

def run_mission(mission: MissionInput, profile: AircraftProfile, weather: WeatherDay,
                pert: Perturbation | None = None) -> MissionRun:
    pert = pert or Perturbation()
    if len(mission.waypoints) < 1:
        raise ValueError("웨이포인트가 최소 1개 필요합니다.")

    start = _parse_local(mission.date, mission.time)
    base_hour = start.hour

    def hour_at(elapsed_s: float) -> WeatherHour:
        idx = base_hour + int((start.minute * 60 + elapsed_s) // 3600)
        return weather.hour(idx)

    def wind_at(elapsed_s: float, alt_m: float) -> tuple[float, float]:
        h = hour_at(elapsed_s)
        spd, direction = h.wind_at(alt_m)
        spd = max(0.0, spd * pert.wind_scale + pert.wind_add_ms)
        return spd, direction

    temp0 = weather.hour(base_hour).temp_c
    temp_c = None if temp0 is None else temp0 + pert.temp_add_c
    cap = capacity_factor_for_temp(temp_c) * pert.battery_factor
    usable_wh = profile.usable_wh * cap
    payload = mission.payload_kg
    p_hover = profile.hover_power_w * power_scale_for_payload(profile, payload) * pert.power_factor
    p_climb = p_hover + profile.climb_extra_w * pert.power_factor
    p_desc = p_hover * 0.8
    p_cruise = cruise_power_w(profile, profile.cruise_speed_ms, payload) * pert.power_factor

    segs: list[Segment] = []
    t = 0.0
    e = 0.0
    dist_total = 0.0
    home = mission.waypoints[0]
    failures: list[str] = []
    control_fail = False

    def add(seg: Segment) -> None:
        nonlocal t, e, dist_total
        seg.start_s = t
        t += seg.time_s
        e += seg.energy_wh
        dist_total += seg.distance_m
        segs.append(seg)

    # 이륙
    climb_t = home.alt_m / profile.climb_rate_ms if profile.climb_rate_ms > 0 else 0.0
    add(Segment("takeoff", f"이륙 → {home.alt_m:.0f} m", 0.0, climb_t, p_climb * climb_t / 3600.0, 0.0))

    def leg(frm: Waypoint, to: Waypoint, label: str, kind: str) -> None:
        nonlocal control_fail
        d = haversine_m(frm.lat, frm.lon, to.lat, to.lon)
        trk = bearing_deg(frm.lat, frm.lon, to.lat, to.lon) if d > 0.5 else 0.0
        alt_mid = (frm.alt_m + to.alt_m) / 2.0
        wspd, wdir = wind_at(t, alt_mid)
        along, cross = wind_components(wspd, wdir, trk)
        gs = ground_speed_ms(profile.cruise_speed_ms, along, cross) if d > 0.5 else profile.cruise_speed_ms
        dalt = to.alt_m - frm.alt_m
        vert_t = abs(dalt) / (profile.climb_rate_ms if dalt > 0 else profile.descent_rate_ms) if dalt else 0.0
        status, note = OK, ""
        if gs is None or gs < 1.0:
            status, note = FAIL, "맞바람·측풍으로 경로 유지 불가"
            control_fail = True
            horiz_t = d / 1.0
        else:
            horiz_t = d / gs
            if gs < 0.5 * profile.cruise_speed_ms:
                status, note = WARN, "맞바람으로 지상속도 크게 감소"
        time_s = max(horiz_t, vert_t)
        energy = (p_cruise * horiz_t + (p_climb if dalt > 0 else p_desc) * max(0.0, vert_t - horiz_t)) / 3600.0
        add(Segment(kind, label, d, time_s, energy, 0.0, gs, wspd, wdir, along, cross, status, note))

    for i, wp in enumerate(mission.waypoints):
        if i > 0:
            leg(mission.waypoints[i - 1], wp, f"WP{i} → WP{i + 1}", "leg")
        if wp.hover_s > 0:
            add(Segment("hover", f"WP{i + 1} 체공 {wp.hover_s:.0f} s", 0.0, wp.hover_s,
                        p_hover * wp.hover_s / 3600.0, 0.0))

    if mission.return_to_home and len(mission.waypoints) > 1:
        last = mission.waypoints[-1]
        rth = Waypoint(home.lat, home.lon, last.alt_m, 0.0)
        leg(last, rth, f"WP{len(mission.waypoints)} → 출발지 복귀", "return")
        land_alt = last.alt_m
    else:
        land_alt = mission.waypoints[-1].alt_m
    desc_t = land_alt / profile.descent_rate_ms if profile.descent_rate_ms > 0 else 0.0
    add(Segment("land", "착륙", 0.0, desc_t, p_desc * desc_t / 3600.0, 0.0))

    max_dist_home = max((haversine_m(home.lat, home.lon, w.lat, w.lon) for w in mission.waypoints), default=0.0)
    max_alt = max(w.alt_m for w in mission.waypoints)
    end = start + dt.timedelta(seconds=t)
    used_frac = e / usable_wh if usable_wh > 0 else float("inf")

    # ------------------------------------------------------------ 판정
    checks: list[Check] = []
    h0 = weather.hour(base_hour)
    wspd0, _ = wind_at(0.0, max_alt)
    r = wspd0 / profile.max_wind_ms if profile.max_wind_ms > 0 else 0.0
    checks.append(Check("wind", "풍속(비행 고도)", FAIL if r > 1.0 else WARN if r > 0.7 else OK,
                        f"{wspd0:.1f} m/s", f"≤ {profile.max_wind_ms:.0f} m/s",
                        "기체 풍속 한계 초과" if r > 1.0 else "풍속이 한계의 70% 초과" if r > 0.7 else "양호"))

    if h0.gust_ms is None:
        checks.append(Check("gust", "돌풍", INFO, "자료 없음", f"≤ {profile.max_gust_ms:.0f} m/s",
                            "돌풍 자료 없음(기상청 단기예보), 풍속 판정으로 대체"))
    else:
        gust = max(0.0, h0.gust_ms * pert.gust_scale * pert.wind_scale + pert.wind_add_ms)
        rg = gust / profile.max_gust_ms if profile.max_gust_ms > 0 else 0.0
        checks.append(Check("gust", "돌풍", FAIL if rg > 1.0 else WARN if rg > 0.8 else OK,
                            f"{gust:.1f} m/s", f"≤ {profile.max_gust_ms:.0f} m/s",
                            "돌풍 한계 초과" if rg > 1.0 else "돌풍이 한계에 근접" if rg > 0.8 else "양호"))

    precip = h0.precip_mm or 0.0
    prob = h0.precip_prob
    if pert.rain_happens is None:
        rain = precip > 0.1
    else:
        rain = pert.rain_happens or precip > 0.1
    if rain and not profile.rain_ok:
        st, msg = FAIL, "강수 예상, 방수 기체 아님"
    elif rain:
        st, msg = WARN, "강수 예상, 방수 기체로 가능하나 영상 품질 저하"
    elif prob is not None and prob >= 40.0:
        st, msg = WARN, f"강수 확률 {prob:.0f}%"
    else:
        st, msg = OK, "양호"
    prob_txt = f" / 확률 {prob:.0f}%" if prob is not None else ""
    checks.append(Check("precip", "강수", st, f"{precip:.1f} mm{prob_txt}",
                        "0 mm" if not profile.rain_ok else "방수 기체", msg))

    temp_limit = f"{profile.temp_min_c:.0f}~{profile.temp_max_c:.0f} °C"
    if temp_c is None:
        checks.append(Check("temp", "기온", INFO, "자료 없음", temp_limit, "기온 자료 없음"))
    else:
        if temp_c < profile.temp_min_c or temp_c > profile.temp_max_c:
            st, msg = FAIL, "기체 운용 온도 범위 밖"
        elif temp_c < profile.temp_min_c + 5 or temp_c > profile.temp_max_c - 5:
            st, msg = WARN, "운용 온도 한계에 근접"
        elif temp_c < 5.0:
            st, msg = WARN, f"저온으로 가용 용량 {capacity_factor_for_temp(temp_c):.0%}"
        else:
            st, msg = OK, "양호"
        checks.append(Check("temp", "기온", st, f"{temp_c:.1f} °C", temp_limit, msg))

    vis = h0.visibility_m
    vis_limit = f"≥ {profile.min_visibility_m / 1000:.0f} km"
    if vis is None:
        checks.append(Check("vis", "시정", INFO, "자료 없음", vis_limit, "이 자료에는 시정 정보가 없음"))
    else:
        st = FAIL if vis < profile.min_visibility_m else WARN if vis < 1.5 * profile.min_visibility_m else OK
        checks.append(Check("vis", "시정", st, f"{vis / 1000:.1f} km", vis_limit,
                            "시정 기준 미달" if st == FAIL else "시정 다소 낮음" if st == WARN else "양호"))

    sr, ss = _parse_iso_minute(weather.sunrise), _parse_iso_minute(weather.sunset)
    if sr and ss:
        is_night = start < sr or end > ss
        near = (not is_night) and (start < sr + dt.timedelta(minutes=30) or end > ss - dt.timedelta(minutes=30))
        if is_night and not (mission.night_approved and profile.night_capable):
            st, msg = FAIL, "야간 비행(일출 전/일몰 후), 승인·조명 없음"
        elif is_night:
            st, msg = WARN, "야간 비행, 승인·조명 보유 조건으로 가능"
        elif near:
            st, msg = WARN, "일출·일몰 30분 이내"
        else:
            st, msg = OK, "주간"
        checks.append(Check("daylight", "주·야간", st, f"{start:%H:%M}~{end:%H:%M}", f"{sr:%H:%M}~{ss:%H:%M}", msg))
    else:
        checks.append(Check("daylight", "주·야간", INFO, f"{start:%H:%M}~{end:%H:%M}", "-", "일출·일몰 자료 없음"))

    st = FAIL if used_frac > 1.0 else WARN if used_frac > 0.85 else OK
    checks.append(Check("battery", "배터리", st, f"{e:.0f} Wh ({used_frac:.0%} 사용)", f"가용 {usable_wh:.0f} Wh",
                        "가용 용량 초과" if st == FAIL else "여유 15% 미만" if st == WARN else "양호"))

    if max_dist_home > profile.telemetry_range_m:
        st, msg = FAIL, "텔레메트리 거리 초과"
    elif mission.vlos and max_dist_home > 500.0:
        st, msg = WARN, "가시권 유지 어려움, 관측자·특별승인 필요"
    else:
        st, msg = OK, "양호"
    checks.append(Check("range", "최대 이격거리", st, f"{max_dist_home:.0f} m", f"≤ {profile.telemetry_range_m:.0f} m", msg))

    if max_alt > profile.max_altitude_m:
        st, msg = FAIL, "기체 최대 고도 초과"
    elif max_alt > 150.0:
        st, msg = WARN, "150 m 초과, 비행승인 필요"
    else:
        st, msg = OK, "양호"
    checks.append(Check("altitude", "비행 고도", st, f"{max_alt:.0f} m", f"≤ {profile.max_altitude_m:.0f} m", msg))

    checks.append(Check("control", "경로 유지", FAIL if control_fail else OK,
                        "불가 구간 있음" if control_fail else "전 구간 가능", f"순항 {profile.cruise_speed_ms:.0f} m/s",
                        "맞바람·측풍이 순항속도를 초과하는 구간 존재" if control_fail else "양호"))

    if payload > profile.payload_max_kg:
        checks.append(Check("payload", "페이로드", FAIL, f"{payload:.1f} kg", f"≤ {profile.payload_max_kg:.1f} kg",
                            "최대 페이로드 초과"))

    overall = OK
    for c in checks:
        if _ORDER[c.status] > _ORDER[overall]:
            overall = c.status
        if c.status == FAIL:
            failures.append(c.title)

    return MissionRun(
        segments=segs, checks=checks, total_time_s=t, total_distance_m=dist_total,
        total_energy_wh=e, usable_wh=usable_wh, battery_used_frac=used_frac,
        max_dist_home_m=max_dist_home, max_alt_m=max_alt,
        start_time=start.isoformat(timespec="minutes"), end_time=end.isoformat(timespec="minutes"),
        overall=overall, failures=failures,
    )


# ---------------------------------------------------------------- 몬테카를로

def monte_carlo(mission: MissionInput, profile: AircraftProfile, weather: WeatherDay,
                n_runs: int = 500, seed: int = 0) -> dict[str, Any]:
    rng = random.Random(seed)
    start = _parse_local(mission.date, mission.time)
    h0 = weather.hour(start.hour)
    prob = h0.precip_prob
    successes = 0
    reasons: dict[str, int] = {}
    used: list[float] = []
    times: list[float] = []
    for _ in range(n_runs):
        rain = None if prob is None else (rng.random() * 100.0 < prob)
        pert = Perturbation(
            wind_scale=max(0.3, rng.gauss(1.0, 0.15)),
            wind_add_ms=rng.gauss(0.0, 0.8),
            gust_scale=max(0.5, rng.gauss(1.0, 0.12)),
            temp_add_c=rng.gauss(0.0, 1.5),
            battery_factor=max(0.7, rng.gauss(1.0, 0.05)),
            power_factor=max(0.8, rng.gauss(1.0, 0.07)),
            rain_happens=rain,
        )
        r = run_mission(mission, profile, weather, pert)
        used.append(r.battery_used_frac)
        times.append(r.total_time_s)
        if r.overall != FAIL:
            successes += 1
        for f in r.failures:
            reasons[f] = reasons.get(f, 0) + 1

    def pct(xs: list[float], q: float) -> float:
        s = sorted(xs)
        if not s:
            return 0.0
        k = min(len(s) - 1, max(0, int(round(q * (len(s) - 1)))))
        return s[k]

    return {
        "runs": n_runs,
        "success_probability": successes / n_runs if n_runs else 0.0,
        "failure_reasons": sorted(({"reason": k, "count": v, "share": v / n_runs} for k, v in reasons.items()),
                                  key=lambda x: -x["count"]),
        "battery_used_p10": pct(used, 0.10), "battery_used_p50": pct(used, 0.50), "battery_used_p90": pct(used, 0.90),
        "time_p10_s": pct(times, 0.10), "time_p50_s": pct(times, 0.50), "time_p90_s": pct(times, 0.90),
    }


# ---------------------------------------------------------------- 종합 평가

def evaluate(mission: MissionInput, profile: AircraftProfile, weather: WeatherDay,
             n_runs: int = 500, seed: int = 0) -> dict[str, Any]:
    nominal = run_mission(mission, profile, weather)
    mc = monte_carlo(mission, profile, weather, n_runs=n_runs, seed=seed)

    start = _parse_local(mission.date, mission.time)
    h0 = weather.hour(start.hour)
    wspd0, _ = h0.wind_at(nominal.max_alt_m)
    daylight = next((c for c in nominal.checks if c.key == "daylight"), None)
    is_night = bool(daylight and daylight.status in (FAIL, WARN) and "야간" in daylight.message)
    packs = max(1, math.ceil(nominal.total_energy_wh / nominal.usable_wh)) if nominal.usable_wh > 0 else 1
    flags = hardware.derive_flags(
        profile=profile, mission_type=mission.mission_type, payload_kg=mission.payload_kg,
        max_dist_home_m=nominal.max_dist_home_m, max_alt_m=nominal.max_alt_m, vlos=mission.vlos,
        is_night=is_night, gps_risk=mission.gps_risk,
        wind_ratio=(wspd0 / profile.max_wind_ms if profile.max_wind_ms else 0.0),
        rain_expected=(h0.precip_mm or 0.0) > 0.1 or ((h0.precip_prob or 0.0) >= 40.0),
        temp_c=h0.temp_c, packs_needed=packs,
    )
    hw = hardware.hardware_list(profile, flags, nominal.total_energy_wh)

    verdict = "불가" if nominal.overall == FAIL else "주의" if nominal.overall == WARN else "가능"
    p = mc["success_probability"]
    if nominal.overall != FAIL and p < 0.6:
        verdict = "주의"

    return {
        "verdict": verdict,
        "overall": nominal.overall,
        "nominal": asdict(nominal),
        "monte_carlo": mc,
        "hardware": hw,
        "flags": flags,
        "weather": weather.to_dict(),
        "weather_at_start": {
            "time": h0.time, "temp_c": h0.temp_c, "precip_mm": h0.precip_mm, "precip_prob": h0.precip_prob,
            "visibility_m": h0.visibility_m, "cloud_cover": h0.cloud_cover, "gust_ms": h0.gust_ms,
            "wind_10m": list(h0.wind_at(10.0)), "wind_alt": list(h0.wind_at(nominal.max_alt_m)),
        },
        "profile": asdict(profile),
        "mission": mission.to_dict(),
    }
