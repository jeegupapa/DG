"""임무 조건으로부터 필요한 하드웨어 품목을 규칙 기반으로 도출."""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

from .models import AircraftProfile

_RULES_PATH = Path(__file__).resolve().parent / "data" / "hardware_rules.json"


def load_rules(path: Path | None = None) -> dict[str, Any]:
    with open(path or _RULES_PATH, encoding="utf-8") as f:
        return json.load(f)


def derive_flags(*, profile: AircraftProfile, mission_type: str, payload_kg: float,
                 max_dist_home_m: float, max_alt_m: float, vlos: bool, is_night: bool,
                 gps_risk: bool, wind_ratio: float, rain_expected: bool, temp_c: float | None,
                 packs_needed: int) -> dict[str, bool]:
    return {
        "bvlos": (not vlos) or max_dist_home_m > 500.0 or max_dist_home_m > profile.telemetry_range_m,
        "night": is_night,
        "high_altitude": max_alt_m > 150.0,
        "long_duration": packs_needed > 1,
        "camera_payload": mission_type in ("촬영", "측량"),
        "survey_payload": mission_type == "측량",
        "delivery_payload": mission_type == "운송",
        "patrol_payload": mission_type == "순찰",
        "gps_risk": gps_risk,
        "strong_wind": wind_ratio > 0.7,
        "rain": rain_expected and not profile.rain_ok,
        "cold": temp_c is not None and temp_c < 5.0,
        "heavy_payload": profile.payload_max_kg > 0 and payload_kg > 0.7 * profile.payload_max_kg,
    }


def battery_items(profile: AircraftProfile, mission_energy_wh: float) -> list[dict[str, str]]:
    packs_per_sortie = max(1, math.ceil(mission_energy_wh / profile.usable_wh)) if profile.usable_wh > 0 else 1
    recommended = packs_per_sortie * 3   # 비행 1회분 + 충전 대기 2회분
    return [{
        "category": "전원",
        "name": "비행 배터리",
        "spec": f"{profile.battery_wh:.0f} Wh 급 × {recommended}개 (1회 비행 {packs_per_sortie}개 소요)",
        "reason": f"임무 소요 전력 약 {mission_energy_wh:.0f} Wh, 예비 {profile.reserve_fraction:.0%} 포함",
    }]


def hardware_list(profile: AircraftProfile, flags: dict[str, bool], mission_energy_wh: float,
                  rules: dict[str, Any] | None = None) -> list[dict[str, str]]:
    rules = rules or load_rules()
    fmt = {"frame_class": profile.frame_class, "profile_name": profile.name}
    items: list[dict[str, str]] = []
    for it in rules.get("base", []):
        items.append({k: str(v).format(**fmt) for k, v in it.items()})
    items.extend(battery_items(profile, mission_energy_wh))
    for flag, on in flags.items():
        if not on:
            continue
        for it in rules.get("conditional", {}).get(flag, []):
            d = {k: str(v).format(**fmt) for k, v in it.items()}
            d["trigger"] = flag
            items.append(d)
    return items
