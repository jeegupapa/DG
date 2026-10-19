"""임무 조건(거리·고도·순항 속도·페이로드·기상)으로부터 멀티콥터 하드웨어 사양을 역산한다.

이륙중량을 반복 수렴시키며 운동량 이론으로 호버 전력을, 속도·맞바람 보정으로 순항 전력을 구하고,
필요한 배터리(Wh → 셀 수·용량·팩 수)와 부품 표(data/components.json)의 모터·프롭·ESC·프레임 급을 고른다.
모든 값은 ±20~30% 오차를 가진 사전 추정치이며, 단위와 가정은 결과 dict 의 units/assumptions 에 적는다.
"""
from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any

from .geo import haversine_m
from .models import AircraftProfile, MissionInput, WeatherDay
from .simulate import _parse_local, capacity_factor_for_temp, cruise_power_w, power_scale_for_payload

_COMPONENTS_PATH = Path(__file__).resolve().parent / "data" / "components.json"

G = 9.80665
THRUST_RATIO = 2.0            # 최대 추력 ÷ 이륙중량 (호버 스로틀 약 50%)
FIGURE_OF_MERIT = 0.7         # 로터 성능계수 (이상 유도동력 대비)
DRIVE_EFFICIENCY = 0.75       # 모터·ESC·배선 효율
CLIMB_RATE_MS = 3.0
DESCENT_RATE_MS = 2.0
DESCENT_POWER_FRAC = 0.8
TAKEOFF_LANDING_HOVER_S = 30.0
HEADWIND_FRACTION = 0.5       # 경로의 절반은 맞바람, 절반은 뒷바람으로 가정
ESC_MARGIN = 1.3
MIN_ENDURANCE_MIN = 10.0      # 임무가 짧아도 최소 이 시간만큼 호버 가능한 배터리
CELL_NOMINAL_V = 3.7
PACK_ROUND_MAH = 500
FRAME_ARM_FACTOR = 0.15       # 모터 4개 초과 1개당 프레임 중량 +15%
VALID_MOTORS = (4, 6, 8)

REGULATIONS = [
    (0.25, "최대이륙중량 250 g 초과", "조종자 자격(4종 이상) 필요 가능성"),
    (2.0, "최대이륙중량 2 kg 초과", "기체 신고 대상 가능성"),
    (25.0, "최대이륙중량 25 kg 초과", "안전성 인증·비행승인 대상 가능성"),
]
REGULATION_NOTE = ("참고용 문구입니다. 항공안전법·시행규칙의 세부 조건(사업용 여부, 공역, 개정 사항)은 "
                   "드론원스톱(drone.onestop.go.kr)에서 확인하세요.")

UNITS = {
    "distance": "m", "speed": "m/s", "mass": "kg", "power": "W", "energy": "Wh", "time": "s",
    "capacity": "mAh", "current": "A", "prop": "inch", "thrust": "gf", "temp": "°C",
}


def load_components(path: Path | None = None) -> dict[str, Any]:
    with open(path or _COMPONENTS_PATH, encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------- 입력

@dataclass
class SizingInput:
    total_distance_m: float
    max_dist_home_m: float = 0.0
    alt_m: float = 50.0
    cruise_speed_ms: float = 8.0
    hover_time_s: float = 0.0
    payload_kg: float = 0.0
    motors: int = 4
    wind_ms: float = 0.0
    temp_c: float | None = 20.0
    reserve_fraction: float = 0.25
    min_endurance_min: float = MIN_ENDURANCE_MIN

    def validate(self) -> None:
        if self.motors not in VALID_MOTORS:
            raise ValueError(f"모터 수는 {', '.join(map(str, VALID_MOTORS))} 중 하나여야 합니다: {self.motors}")
        if self.cruise_speed_ms <= 0:
            raise ValueError("목표 순항 속도는 0보다 커야 합니다.")
        if self.total_distance_m < 0 or self.payload_kg < 0 or self.hover_time_s < 0 or self.alt_m < 0:
            raise ValueError("거리·페이로드·체공시간·고도는 음수일 수 없습니다.")
        if not 0.0 <= self.reserve_fraction < 1.0:
            raise ValueError("예비 비율은 0 이상 1 미만이어야 합니다.")


# ---------------------------------------------------------------- 물리 모델

def air_density(temp_c: float | None) -> float:
    """해면 기압에서의 공기밀도(kg/m³). 기온만 반영(비행 고도 150 m 이하는 무시)."""
    t = 15.0 if temp_c is None else temp_c
    return 101325.0 / (287.05 * (t + 273.15))


def hover_power_w(mass_kg: float, n_motors: int, prop_in: float, rho: float, avionics_w: float) -> float:
    """운동량 이론 호버 전력: 로터당 T^1.5 / sqrt(2ρA) ÷ (성능계수 × 구동 효율) + 전장 전력."""
    d = prop_in * 0.0254
    area = math.pi * (d / 2.0) ** 2
    thrust = mass_kg * G / n_motors
    p_ideal = thrust ** 1.5 / math.sqrt(2.0 * rho * area)
    return n_motors * p_ideal / (FIGURE_OF_MERIT * DRIVE_EFFICIENCY) + avionics_w


def forward_power_w(mass_kg: float, n_motors: int, prop_in: float, rho: float, airspeed_ms: float,
                    cda_m2: float, avionics_w: float) -> float:
    """전진 비행 전력(운동량 이론). 유도속도는 v_i² = (−v² + √(v⁴ + 4v_h⁴))/2 로 속도가 붙을수록 줄고,
    유해항력 D = ½ρv²·CdA 가 v³ 으로 늘어나 U자형 전력 곡선이 된다. airspeed 0 이면 호버 전력과 같다."""
    d = prop_in * 0.0254
    area = math.pi * (d / 2.0) ** 2
    drag = 0.5 * rho * airspeed_ms ** 2 * cda_m2
    thrust = math.hypot(mass_kg * G, drag) / n_motors
    v_h = math.sqrt(thrust / (2.0 * rho * area))
    vi2 = (-airspeed_ms ** 2 + math.sqrt(airspeed_ms ** 4 + 4.0 * v_h ** 4)) / 2.0
    v_i = math.sqrt(max(0.0, vi2))
    p_induced = n_motors * thrust * v_i
    p_parasite = drag * airspeed_ms
    return (p_induced + p_parasite) / (FIGURE_OF_MERIT * DRIVE_EFFICIENCY) + avionics_w


def climb_power_w(mass_kg: float, p_hover: float) -> float:
    return p_hover + mass_kg * G * CLIMB_RATE_MS / (FIGURE_OF_MERIT * DRIVE_EFFICIENCY)


def mission_energy(inp: SizingInput, mass_kg: float, p_hover: float, cruise_power_fn) -> dict[str, float]:
    """구간별 시간·에너지. cruise_power_fn(airspeed) 가 대기속도에서의 전력(W)을 돌려준다."""
    v, w = inp.cruise_speed_ms, max(0.0, inp.wind_ms)
    # 지상속도 v 를 유지한다고 보고, 맞바람 구간은 대기속도 v+w, 뒷바람 구간은 max(0, v-w)
    t_cruise = inp.total_distance_m / v
    p_head = cruise_power_fn(v + w)
    p_tail = cruise_power_fn(max(0.0, v - w))
    p_cruise = p_head * HEADWIND_FRACTION + p_tail * (1.0 - HEADWIND_FRACTION)
    e_cruise = p_cruise * t_cruise / 3600.0
    p_climb = climb_power_w(mass_kg, p_hover)
    t_climb = inp.alt_m / CLIMB_RATE_MS
    e_climb = p_climb * t_climb / 3600.0
    t_desc = inp.alt_m / DESCENT_RATE_MS
    e_desc = p_hover * DESCENT_POWER_FRAC * t_desc / 3600.0
    t_hover = inp.hover_time_s + TAKEOFF_LANDING_HOVER_S
    e_hover = p_hover * t_hover / 3600.0
    return {
        "time_s": t_cruise + t_climb + t_desc + t_hover,
        "cruise_time_s": t_cruise, "climb_time_s": t_climb, "descent_time_s": t_desc, "hover_time_s": t_hover,
        "energy_wh": e_cruise + e_climb + e_desc + e_hover,
        "cruise_wh": e_cruise, "climb_wh": e_climb, "descent_wh": e_desc, "hover_wh": e_hover,
        "cruise_power_w": p_cruise, "headwind_power_w": p_head, "tailwind_power_w": p_tail,
        "climb_power_w": p_climb,
    }


# ---------------------------------------------------------------- 부품 선택

def _pick_motor(motors: list[dict[str, Any]], thrust_req_g: float) -> tuple[dict[str, Any], bool]:
    for m in motors:
        if m["thrust_max_g"] >= thrust_req_g:
            return m, True
    return motors[-1], False


def _pick_frame(frames: list[dict[str, Any]], prop_in: float) -> tuple[dict[str, Any], bool]:
    for f in frames:
        if f["max_prop_in"] >= prop_in:
            return f, True
    return frames[-1], False


def _esc_rating(standard: list[int], amps: float) -> int:
    for a in standard:
        if a >= amps:
            return a
    return int(math.ceil(amps / 20.0) * 20)


def _derive(inp: SizingInput, comp: dict[str, Any], rho: float, cap_f: float, mass_kg: float) -> dict[str, Any]:
    """주어진 이륙중량에서 부품·전력·배터리를 한 번 계산한다(반복의 한 스텝)."""
    n = inp.motors
    thrust_req_g = mass_kg * 1000.0 * THRUST_RATIO / n
    motor, motor_ok = _pick_motor(comp["motors"], thrust_req_g)
    frame, frame_ok = _pick_frame(comp["frames"], motor["prop_in"])
    frame_kg = frame["weight_kg"] * (1.0 + FRAME_ARM_FACTOR * (n - 4))
    p_hover = hover_power_w(mass_kg, n, motor["prop_in"], rho, comp["avionics_power_w"])
    cda = frame["cda_m2"] + comp["payload_cda_m2_per_kg"] * inp.payload_kg
    en = mission_energy(inp, mass_kg, p_hover,
                        lambda v_air: forward_power_w(mass_kg, n, motor["prop_in"], rho, v_air, cda,
                                                      comp["avionics_power_w"]))
    en["still_air_cruise_power_w"] = forward_power_w(mass_kg, n, motor["prop_in"], rho, inp.cruise_speed_ms, cda,
                                                     comp["avionics_power_w"])
    wh_min = p_hover * inp.min_endurance_min / 60.0
    mission_wh = max(en["energy_wh"], wh_min)
    required_wh = mission_wh / (1.0 - inp.reserve_fraction) / cap_f
    battery_kg_raw = required_wh / comp["battery_wh_per_kg"]

    cells = int(motor["cells"])
    nominal_v = cells * CELL_NOMINAL_V
    mah = required_wh / nominal_v * 1000.0
    packs = max(1, math.ceil(mah / comp["max_pack_mah"]))
    pack_mah = int(math.ceil(max(comp["min_pack_mah"], mah / packs) / PACK_ROUND_MAH) * PACK_ROUND_MAH)
    battery_wh = pack_mah * packs * nominal_v / 1000.0
    battery_kg = battery_wh / comp["battery_wh_per_kg"]

    per_motor_kg = (motor["weight_g"] + motor["esc_weight_g"] + motor["prop_weight_g"]) / 1000.0
    dry_kg = inp.payload_kg + comp["electronics_kg"] + frame_kg + n * per_motor_kg
    return {
        "thrust_req_g": thrust_req_g, "motor": motor, "motor_ok": motor_ok, "frame": frame, "frame_ok": frame_ok,
        "frame_kg": frame_kg, "cda_m2": cda, "p_hover": p_hover, "energy": en, "min_endurance_wh": wh_min,
        "mission_wh": mission_wh, "required_wh": required_wh,
        "cells": cells, "nominal_v": nominal_v, "mah": mah, "packs": packs, "pack_mah": pack_mah,
        "battery_wh": battery_wh, "battery_kg": battery_kg, "battery_kg_raw": battery_kg_raw,
        "dry_kg": dry_kg, "mass_total_raw": dry_kg + battery_kg_raw, "mass_total": dry_kg + battery_kg,
    }


# ---------------------------------------------------------------- 기존 프로필 적합성

def match_profiles(inp: SizingInput, profiles: dict[str, AircraftProfile], cap_f: float) -> list[dict[str, Any]]:
    out = []
    for p in profiles.values():
        reasons: list[str] = []
        if inp.payload_kg > p.payload_max_kg:
            reasons.append(f"페이로드 {inp.payload_kg:.1f} kg > 최대 {p.payload_max_kg:.1f} kg")
        if inp.cruise_speed_ms > p.max_speed_ms:
            reasons.append(f"목표 속도 {inp.cruise_speed_ms:.0f} m/s > 최대속도 {p.max_speed_ms:.0f} m/s")
        if inp.wind_ms > p.max_wind_ms:
            reasons.append(f"풍속 {inp.wind_ms:.1f} m/s > 한계 {p.max_wind_ms:.0f} m/s")
        if inp.max_dist_home_m > p.telemetry_range_m:
            reasons.append(f"이격 {inp.max_dist_home_m:.0f} m > 텔레메트리 {p.telemetry_range_m:.0f} m")
        if inp.alt_m > p.max_altitude_m:
            reasons.append(f"고도 {inp.alt_m:.0f} m > 최대 {p.max_altitude_m:.0f} m")
        if inp.temp_c is not None and not (p.temp_min_c <= inp.temp_c <= p.temp_max_c):
            reasons.append(f"기온 {inp.temp_c:.0f} °C 가 운용 범위 밖")
        p_h = p.hover_power_w * power_scale_for_payload(p, inp.payload_kg)
        en = mission_energy(inp, p.weight_kg + inp.payload_kg, p_h,
                            cruise_power_fn=lambda v_air, _p=p: cruise_power_w(_p, v_air, inp.payload_kg))
        usable = p.usable_wh * cap_f
        if en["energy_wh"] > usable:
            reasons.append(f"필요 {en['energy_wh']:.0f} Wh > 가용 {usable:.0f} Wh")
        out.append({
            "id": p.id, "name": p.name, "frame_class": p.frame_class, "weight_kg": p.weight_kg,
            "ok": not reasons, "reasons": reasons,
            "energy_wh": round(en["energy_wh"], 1), "usable_wh": round(usable, 1),
            "battery_used_frac": round(en["energy_wh"] / usable, 3) if usable > 0 else None,
        })
    return out


# ---------------------------------------------------------------- 사이징

def size(inp: SizingInput, components: dict[str, Any] | None = None,
         profiles: dict[str, AircraftProfile] | None = None, with_sensitivity: bool = True,
         max_iter: int = 100, tol_kg: float = 0.005) -> dict[str, Any]:
    """임무 조건으로부터 하드웨어 사양 제안 dict 를 만든다."""
    inp.validate()
    comp = components or load_components()
    rho = air_density(inp.temp_c)
    cap_f = capacity_factor_for_temp(inp.temp_c)
    warnings: list[str] = []

    # 이륙중량 반복 수렴(연속 모델: 배터리 중량은 반올림 전 값, 0.5 감쇠)
    mass = inp.payload_kg + comp["electronics_kg"] + 1.0
    converged, iterations, diverged = False, 0, False
    for iterations in range(1, max_iter + 1):
        d = _derive(inp, comp, rho, cap_f, mass)
        new_mass = d["mass_total_raw"]
        if new_mass > 120.0 or not math.isfinite(new_mass):
            diverged = True
            break
        if abs(new_mass - mass) < tol_kg:
            mass = new_mass
            converged = True
            break
        mass = 0.5 * (mass + new_mass)
    if diverged:
        warnings.append("이륙중량이 수렴하지 않습니다. 배터리 중량이 늘어나는 속도가 양력 여유보다 커서 "
                        "LiPo 멀티콥터로는 실현이 어려운 조건입니다(거리·속도·페이로드를 줄이세요).")
    elif not converged:
        warnings.append(f"이륙중량이 {max_iter}회 반복에서 {tol_kg * 1000:.0f} g 이내로 수렴하지 않아 마지막 값을 사용했습니다.")

    # 최종 사양: 반올림한 배터리를 포함한 이륙중량으로 한 번 더 평가
    d = _derive(inp, comp, rho, cap_f, mass)
    mtow = d["mass_total"]
    d = _derive(inp, comp, rho, cap_f, mtow)
    motor, frame, en = d["motor"], d["frame"], d["energy"]
    n = inp.motors
    thrust_avail_kg = n * motor["thrust_max_g"] / 1000.0
    thrust_ratio = thrust_avail_kg / mtow if mtow > 0 else 0.0
    usable_wh = d["battery_wh"] * (1.0 - inp.reserve_fraction) * cap_f
    hover_endurance_min = usable_wh / d["p_hover"] * 60.0 if d["p_hover"] > 0 else 0.0
    esc_a = _esc_rating(comp["esc_standard_a"], motor["max_current_a"] * ESC_MARGIN)

    if not d["motor_ok"]:
        warnings.append(f"요구 추력 {d['thrust_req_g']:.0f} gf/모터가 부품 표의 최대 급({motor['class']})을 넘습니다. "
                        f"모터 수를 늘리거나 페이로드를 줄이세요.")
    if not d["frame_ok"]:
        warnings.append(f"프롭 {motor['prop_in']} 인치를 수용하는 프레임 급이 부품 표에 없습니다.")
    if thrust_ratio < THRUST_RATIO * 0.95:
        warnings.append(f"달성 추력비 {thrust_ratio:.2f} 가 기준 {THRUST_RATIO:.1f} 에 못 미칩니다(배터리 반올림 영향).")
    if inp.wind_ms >= inp.cruise_speed_ms:
        warnings.append(f"풍속 {inp.wind_ms:.1f} m/s 가 목표 순항 속도 {inp.cruise_speed_ms:.0f} m/s 이상입니다. "
                        f"맞바람 구간에서 경로 유지가 어렵습니다.")
    if d["min_endurance_wh"] > en["energy_wh"]:
        warnings.append(f"임무 에너지({en['energy_wh']:.0f} Wh)보다 최소 체공 {inp.min_endurance_min:.0f}분 기준"
                        f"({d['min_endurance_wh']:.0f} Wh)이 커서 그 값으로 배터리를 정했습니다.")
    if inp.temp_c is not None and inp.temp_c < 5.0:
        warnings.append(f"저온({inp.temp_c:.0f} °C)으로 배터리 가용 용량을 {cap_f:.0%} 로 보정했습니다.")

    # 기존 프로필 추천
    prof_checks = match_profiles(inp, profiles, cap_f) if profiles else []
    ok_profiles = sorted((p for p in prof_checks if p["ok"]), key=lambda p: p["weight_kg"])
    recommended = ok_profiles[0] if ok_profiles else None

    summary = {
        "frame_class": frame["class"], "frame_label": frame["label"], "motors": n,
        "motor_class": motor["class"], "kv_range": list(motor["kv_range"]),
        "prop_in": motor["prop_in"], "prop_range_in": list(motor["prop_range_in"]),
        "esc_a": esc_a, "motor_max_current_a": motor["max_current_a"],
        "cells": d["cells"], "pack_mah": d["pack_mah"], "packs": d["packs"],
        "battery_wh": round(d["battery_wh"], 1), "battery_kg": round(d["battery_kg"], 3),
        "mtow_kg": round(mtow, 3), "dry_kg": round(d["dry_kg"], 3), "frame_kg": round(d["frame_kg"], 3),
        "payload_kg": inp.payload_kg,
        "thrust_req_per_motor_g": round(d["thrust_req_g"]), "thrust_max_per_motor_g": motor["thrust_max_g"],
        "thrust_ratio": round(thrust_ratio, 2),
        "hover_power_w": round(d["p_hover"]), "cruise_power_w": round(en["cruise_power_w"]),
        "still_air_cruise_power_w": round(en["still_air_cruise_power_w"]), "cda_m2": round(d["cda_m2"], 3),
        "headwind_power_w": round(en["headwind_power_w"]), "climb_power_w": round(en["climb_power_w"]),
        "mission_time_s": round(en["time_s"]), "mission_energy_wh": round(en["energy_wh"], 1),
        "required_wh": round(d["required_wh"], 1), "usable_wh": round(usable_wh, 1),
        "hover_endurance_min": round(hover_endurance_min, 1),
        "air_density": round(rho, 3), "capacity_factor": round(cap_f, 3),
        "converged": converged and not diverged, "iterations": iterations,
        "feasible": converged and not diverged and d["motor_ok"] and thrust_ratio >= 1.5,
        "recommended_profile_id": recommended["id"] if recommended else None,
        "recommended_profile_name": recommended["name"] if recommended else None,
        "custom": recommended is None,
    }

    components_table = [
        {"item": "프레임", "spec": f"{frame['label']} 멀티콥터 ({n}모터)",
         "note": f"프롭 최대 {frame['max_prop_in']} 인치 · 자중 약 {d['frame_kg']:.2f} kg"},
        {"item": "모터", "spec": f"{n} × {motor['class']} 급, KV {motor['kv_range'][0]}~{motor['kv_range'][1]}",
         "note": f"모터당 최대 추력 약 {motor['thrust_max_g']} gf · 요구 {d['thrust_req_g']:.0f} gf (추력비 {THRUST_RATIO:.1f})"},
        {"item": "프로펠러", "spec": f"{motor['prop_in']} 인치 × {n}",
         "note": f"권장 범위 {motor['prop_range_in'][0]}~{motor['prop_range_in'][1]} 인치"},
        {"item": "ESC", "spec": f"{esc_a} A × {n}",
         "note": f"모터 최대 {motor['max_current_a']} A × 여유 {ESC_MARGIN:.1f}"},
        {"item": "배터리", "spec": f"{d['cells']}S LiPo {d['pack_mah']:,} mAh × {d['packs']}팩",
         "note": f"약 {d['battery_wh']:.0f} Wh, {d['battery_kg']:.2f} kg · 필요 {d['required_wh']:.0f} Wh "
                 f"= 임무 {d['mission_wh']:.0f} Wh ÷ (1−예비 {inp.reserve_fraction:.0%}) ÷ 저온 보정 {cap_f:.2f}"},
        {"item": "비행제어·전장", "spec": f"FC + GNSS + 텔레메트리 + 배선 약 {comp['electronics_kg']:.2f} kg",
         "note": f"전장 소비전력 {comp['avionics_power_w']:.0f} W 가정"},
        {"item": "페이로드", "spec": f"{inp.payload_kg:.2f} kg", "note": "입력값"},
    ]

    assumptions = [
        f"추력비 {THRUST_RATIO:.1f}(최대 추력 ÷ 이륙중량), 모터당 요구 추력 = 이륙중량 × {THRUST_RATIO:.1f} ÷ 모터 수",
        f"호버 전력 = 운동량 이론 유도동력(T^1.5/√(2ρA)) ÷ 성능계수 {FIGURE_OF_MERIT} ÷ 구동 효율 {DRIVE_EFFICIENCY} + 전장 {comp['avionics_power_w']:.0f} W",
        f"순항 전력 = 전진비행 유도동력(유도속도 v_i² = (−v² + √(v⁴ + 4v_h⁴))/2) + 유해항력 전력(½ρv³·CdA, 등가 평판 면적 "
        f"{d['cda_m2']:.3f} m² = 프레임 급별 값 + 페이로드 {comp['payload_cda_m2_per_kg']} m²/kg) ÷ 성능계수 ÷ 효율; "
        f"경로의 {HEADWIND_FRACTION:.0%}는 맞바람(대기속도 = 순항속도 + 풍속), 나머지는 뒷바람",
        f"상승 {CLIMB_RATE_MS:.0f} m/s(추가 전력 = 중량 × 상승률 ÷ 효율), 하강 {DESCENT_RATE_MS:.0f} m/s(호버 전력의 {DESCENT_POWER_FRAC:.0%}), 이착륙 호버 {TAKEOFF_LANDING_HOVER_S:.0f} s",
        f"필요 Wh = max(임무 에너지, 호버 {inp.min_endurance_min:.0f}분) ÷ (1 − 예비 {inp.reserve_fraction:.0%}) ÷ 기온 보정, LiPo {comp['battery_wh_per_kg']:.0f} Wh/kg, 셀 공칭 {CELL_NOMINAL_V} V",
        f"프레임 자중은 급별 대표치에 모터 4개 초과 1개당 {FRAME_ARM_FACTOR:.0%} 가산, 전장 {comp['electronics_kg']:.2f} kg 고정",
        f"공기밀도는 해면 기압·기온({inp.temp_c if inp.temp_c is not None else 15:.0f} °C)으로 {rho:.3f} kg/m³",
        "부품 표(components.json)는 시판 부품의 대표치이며 결과는 ±20~30% 오차를 가진 사전 추정치",
    ]

    regulations = [{"threshold_kg": thr, "condition": cond, "text": text, "applies": mtow > thr}
                   for thr, cond, text in REGULATIONS]

    result: dict[str, Any] = {
        "inputs": asdict(inp),
        "summary": summary,
        "components": components_table,
        "energy_breakdown": {k: round(v, 1) for k, v in en.items()},
        "profile_checks": prof_checks,
        "recommended_profile": recommended,
        "regulations": regulations,
        "regulation_note": REGULATION_NOTE,
        "assumptions": assumptions,
        "warnings": warnings,
        "units": UNITS,
    }
    if with_sensitivity:
        result["sensitivity"] = sensitivity(inp, result, comp)
    return result


# ---------------------------------------------------------------- 민감도

def _rank(comp: dict[str, Any], frame_class: str, motor_class: str) -> tuple[int, int]:
    fi = next(i for i, f in enumerate(comp["frames"]) if f["class"] == frame_class)
    mi = next(i for i, m in enumerate(comp["motors"]) if m["class"] == motor_class)
    return fi, mi


def sensitivity(inp: SizingInput, base: dict[str, Any], comp: dict[str, Any]) -> list[dict[str, Any]]:
    """속도 −2 m/s, 페이로드 −0.5 kg 일 때 한 단계 작은 급으로 가능한지."""
    fi0, mi0 = _rank(comp, base["summary"]["frame_class"], base["summary"]["motor_class"])
    variants = [
        ("speed_minus_2", "순항 속도 −2 m/s", replace(inp, cruise_speed_ms=max(2.0, inp.cruise_speed_ms - 2.0))),
        ("payload_minus_0_5", "페이로드 −0.5 kg", replace(inp, payload_kg=max(0.0, inp.payload_kg - 0.5))),
    ]
    out = []
    for key, label, var in variants:
        if (key == "speed_minus_2" and var.cruise_speed_ms == inp.cruise_speed_ms) or \
           (key == "payload_minus_0_5" and var.payload_kg == inp.payload_kg):
            out.append({"key": key, "label": label, "applicable": False, "note": "변경 여지 없음"})
            continue
        r = size(var, comp, profiles=None, with_sensitivity=False)
        s = r["summary"]
        fi, mi = _rank(comp, s["frame_class"], s["motor_class"])
        out.append({
            "key": key, "label": label, "applicable": True,
            "cruise_speed_ms": var.cruise_speed_ms, "payload_kg": var.payload_kg,
            "frame_class": s["frame_class"], "motor_class": s["motor_class"], "cells": s["cells"],
            "pack_mah": s["pack_mah"], "packs": s["packs"], "mtow_kg": s["mtow_kg"],
            "mission_energy_wh": s["mission_energy_wh"], "required_wh": s["required_wh"],
            "smaller_frame": fi < fi0, "smaller_motor": mi < mi0,
            "one_step_smaller": fi < fi0 or mi < mi0,
            "larger": fi > fi0 or mi > mi0,          # 속도를 낮추면 비행시간이 늘어 오히려 커질 수 있다
            "energy_delta_wh": round(s["mission_energy_wh"] - base["summary"]["mission_energy_wh"], 1),
            "mtow_delta_kg": round(s["mtow_kg"] - base["summary"]["mtow_kg"], 3),
        })
    return out


# ---------------------------------------------------------------- 임무 → 입력

def mission_geometry(mission: MissionInput) -> dict[str, float]:
    """웨이포인트로부터 총 거리(복귀 포함)·최대 이격·최대 고도·체공 합을 구한다."""
    wps = mission.waypoints
    if not wps:
        raise ValueError("웨이포인트가 없습니다.")
    home = wps[0]
    dist = sum(haversine_m(a.lat, a.lon, b.lat, b.lon) for a, b in zip(wps, wps[1:]))
    if mission.return_to_home and len(wps) > 1:
        dist += haversine_m(wps[-1].lat, wps[-1].lon, home.lat, home.lon)
    return {
        "total_distance_m": dist,
        "max_dist_home_m": max(haversine_m(home.lat, home.lon, w.lat, w.lon) for w in wps),
        "max_alt_m": max(w.alt_m for w in wps),
        "hover_time_s": sum(w.hover_s for w in wps),
    }


def propose_for_mission(mission: MissionInput, profile: AircraftProfile, weather: WeatherDay,
                        profiles: dict[str, AircraftProfile] | None = None,
                        cruise_speed_ms: float | None = None, motors: int | None = None) -> dict[str, Any]:
    """simulate 와 같은 기상(출발 시각, 최대 고도의 바람·기온)으로 사이징 입력을 만들어 제안한다."""
    geo = mission_geometry(mission)
    start = _parse_local(mission.date, mission.time)
    h0 = weather.hour(start.hour)
    wind_ms, _ = h0.wind_at(geo["max_alt_m"])
    inp = SizingInput(
        total_distance_m=geo["total_distance_m"], max_dist_home_m=geo["max_dist_home_m"],
        alt_m=geo["max_alt_m"],
        cruise_speed_ms=float(cruise_speed_ms or mission.target_cruise_ms or profile.cruise_speed_ms),
        hover_time_s=geo["hover_time_s"], payload_kg=mission.payload_kg,
        motors=int(motors or mission.motor_count or 4),
        wind_ms=wind_ms, temp_c=h0.temp_c, reserve_fraction=profile.reserve_fraction,
    )
    res = size(inp, profiles=profiles)
    res["geometry"] = geo
    res["weather_used"] = {"time": h0.time, "wind_ms": round(wind_ms, 1), "temp_c": h0.temp_c}
    return res
