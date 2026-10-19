import json

import pytest

from dronesim import api as api_mod
from dronesim.models import MissionInput
from dronesim.sizing import (SizingInput, air_density, hover_power_w, load_components, match_profiles,
                             mission_geometry, propose_for_mission, size)
from dronesim.simulate import capacity_factor_for_temp
from tests.conftest import make_weather


def base(**over) -> SizingInput:
    kw = dict(total_distance_m=1000.0, max_dist_home_m=500.0, alt_m=50.0, cruise_speed_ms=8.0, hover_time_s=0.0,
              payload_kg=0.0, motors=4, wind_ms=3.0, temp_c=18.0, reserve_fraction=0.25)
    kw.update(over)
    return SizingInput(**kw)


# ---------------------------------------------------------------- 물리 모델
def test_air_density_and_hover_power_scale():
    assert air_density(15.0) == pytest.approx(1.225, rel=0.01)
    assert air_density(-10.0) > air_density(30.0)
    p1 = hover_power_w(2.0, 4, 10, 1.225, 0.0)
    p2 = hover_power_w(4.0, 4, 10, 1.225, 0.0)
    assert p2 / p1 == pytest.approx(2 ** 1.5, rel=1e-6)        # P ∝ W^1.5
    assert hover_power_w(2.0, 4, 13, 1.225, 0.0) < p1            # 큰 프롭 → 낮은 원판 하중 → 적은 전력
    assert hover_power_w(2.0, 4, 10, 1.225, 0.0) == pytest.approx(240.0, rel=0.15)   # 500급 2 kg 쿼드 ≈ 250 W 수준


def test_components_table_is_ordered():
    comp = load_components()
    thr = [m["thrust_max_g"] for m in comp["motors"]]
    assert thr == sorted(thr) and len(thr) == 6
    props = [f["max_prop_in"] for f in comp["frames"]]
    assert props == sorted(props) and [f["class"] for f in comp["frames"]] == ["450", "550", "650", "800", "1000"]


# ---------------------------------------------------------------- 수렴·대표 사례
def test_sizing_converges_and_is_consistent():
    r = size(base())
    s = r["summary"]
    assert s["converged"] and s["feasible"] and s["iterations"] < 100
    # 이륙중량 = 기체 건조중량 + 배터리, 추력비 ≥ 2 근처, 필요 Wh 가 임무 에너지보다 크다
    assert s["mtow_kg"] == pytest.approx(s["dry_kg"] + s["battery_kg"], abs=1e-3)
    assert s["thrust_ratio"] >= 1.9
    assert s["required_wh"] > s["mission_energy_wh"]
    assert s["battery_wh"] >= s["required_wh"] * 0.99
    assert r["units"]["energy"] == "Wh" and r["assumptions"]
    json.dumps(r, ensure_ascii=False)


def test_case_short_light_mission_is_450_class_4s_to_6s():
    s = size(base(total_distance_m=1000.0, cruise_speed_ms=8.0, payload_kg=0.0))["summary"]
    assert s["frame_class"] in ("450", "550")
    assert s["motor_class"] in ("2212", "2814")
    assert s["cells"] in (4, 6)
    assert s["packs"] == 1
    assert 1.0 < s["mtow_kg"] < 2.5
    assert s["hover_endurance_min"] >= 10.0           # 최소 체공 10분 기준이 지켜진다


def test_case_6km_12ms_2kg_is_650_or_larger_6s():
    r = size(base(total_distance_m=6000.0, max_dist_home_m=3000.0, cruise_speed_ms=12.0, payload_kg=2.0))
    s = r["summary"]
    assert s["frame_class"] in ("650", "800", "1000")
    assert s["motor_class"] in ("3508", "4114", "5008")
    assert s["cells"] == 6
    assert 6000 <= s["pack_mah"] * s["packs"] <= 22000       # 한 자리수~20 Ah 급 (6S)
    assert 4.5 < s["mtow_kg"] < 9.0
    assert s["thrust_ratio"] >= 1.9
    assert all(c["item"] for c in r["components"]) and len(r["components"]) == 7


def test_more_motors_spread_thrust_to_smaller_motor_class():
    quad = size(base(total_distance_m=6000.0, cruise_speed_ms=12.0, payload_kg=2.0, motors=4))["summary"]
    hexa = size(base(total_distance_m=6000.0, cruise_speed_ms=12.0, payload_kg=2.0, motors=6))["summary"]
    assert hexa["thrust_req_per_motor_g"] < quad["thrust_req_per_motor_g"]
    assert int(hexa["motor_class"]) <= int(quad["motor_class"])


def test_forward_flight_power_curve_is_u_shaped():
    from dronesim.sizing import forward_power_w
    hover = hover_power_w(6.0, 4, 17, 1.225, 20.0)
    assert forward_power_w(6.0, 4, 17, 1.225, 0.0, 0.11, 20.0) == pytest.approx(hover, rel=1e-9)
    curve = [forward_power_w(6.0, 4, 17, 1.225, v, 0.11, 20.0) for v in (0, 5, 10, 15, 20, 25)]
    assert min(curve) < curve[0]                      # 전진 비행에서 유도동력 감소로 전력 최소점이 생긴다
    assert curve[-1] > curve[-2] > curve[-3]          # 고속에서는 유해항력(v³)으로 다시 증가
    assert curve[-1] > hover


def test_headwind_increases_energy_and_battery():
    calm = size(base(total_distance_m=6000.0, cruise_speed_ms=12.0, payload_kg=2.0, wind_ms=0.0))["summary"]
    windy = size(base(total_distance_m=6000.0, cruise_speed_ms=12.0, payload_kg=2.0, wind_ms=10.0))["summary"]
    assert windy["mission_energy_wh"] > calm["mission_energy_wh"] * 1.05
    assert windy["required_wh"] > calm["required_wh"]
    assert windy["headwind_power_w"] > windy["cruise_power_w"] > calm["cruise_power_w"]


def test_cold_requires_more_capacity_and_warns():
    warm = size(base(total_distance_m=6000.0, cruise_speed_ms=12.0, payload_kg=2.0, temp_c=20.0))
    cold = size(base(total_distance_m=6000.0, cruise_speed_ms=12.0, payload_kg=2.0, temp_c=-8.0))
    assert cold["summary"]["capacity_factor"] == pytest.approx(capacity_factor_for_temp(-8.0))
    assert cold["summary"]["required_wh"] > warm["summary"]["required_wh"]
    assert any("저온" in w for w in cold["warnings"])


def test_infeasible_mission_is_flagged_not_crashed():
    r = size(base(total_distance_m=60000.0, cruise_speed_ms=15.0, payload_kg=10.0, motors=8))
    assert r["summary"]["feasible"] is False
    assert any("수렴" in w for w in r["warnings"])


def test_sensitivity_reports_one_step_smaller():
    r = size(base(total_distance_m=6000.0, max_dist_home_m=3000.0, cruise_speed_ms=12.0, payload_kg=2.0))
    sens = {x["key"]: x for x in r["sensitivity"]}
    assert set(sens) == {"speed_minus_2", "payload_minus_0_5"}
    sp, pl = sens["speed_minus_2"], sens["payload_minus_0_5"]
    assert sp["applicable"] and sp["cruise_speed_ms"] == 10.0 and sp["mission_energy_wh"] > 0
    assert pl["applicable"] and pl["payload_kg"] == 1.5 and pl["mtow_kg"] < r["summary"]["mtow_kg"]
    assert isinstance(pl["one_step_smaller"], bool) and isinstance(pl["larger"], bool)
    assert not (pl["one_step_smaller"] and pl["larger"])
    # 페이로드 0 kg 이면 페이로드 민감도는 적용 불가
    r0 = size(base(payload_kg=0.0))
    assert next(x for x in r0["sensitivity"] if x["key"] == "payload_minus_0_5")["applicable"] is False


# ---------------------------------------------------------------- 규정 플래그
def test_regulation_flags_by_mtow():
    light = size(base(total_distance_m=1000.0, payload_kg=0.0))
    flags = {g["threshold_kg"]: g["applies"] for g in light["regulations"]}
    assert flags[0.25] is True and flags[2.0] is False and flags[25.0] is False
    heavy = size(base(total_distance_m=12000.0, cruise_speed_ms=12.0, payload_kg=3.0, motors=8))
    flags = {g["threshold_kg"]: g["applies"] for g in heavy["regulations"]}
    assert flags[2.0] is True
    assert "참고" in heavy["regulation_note"]
    assert all("가능성" in g["text"] for g in heavy["regulations"])     # 단정하지 않는 문구


# ---------------------------------------------------------------- 입력 검증
def test_input_validation():
    with pytest.raises(ValueError):
        size(base(motors=5))
    with pytest.raises(ValueError):
        size(base(cruise_speed_ms=0.0))
    with pytest.raises(ValueError):
        size(base(payload_kg=-1.0))


# ---------------------------------------------------------------- 프로필 추천
def test_profile_match_and_custom(profiles):
    cap = capacity_factor_for_temp(18.0)
    checks = {c["id"]: c for c in match_profiles(base(), profiles, cap)}
    assert checks["quad500"]["ok"] and checks["hexa900"]["ok"]
    r = size(base(), profiles=profiles)
    assert r["summary"]["recommended_profile_id"] == "quad500" and r["summary"]["custom"] is False
    # 페이로드 5 kg 은 어느 프로필도 못 든다 → 맞춤 사양
    r2 = size(base(total_distance_m=3000.0, payload_kg=5.0), profiles=profiles)
    assert r2["summary"]["custom"] is True and r2["recommended_profile"] is None
    assert any("페이로드" in why for c in r2["profile_checks"] for why in c["reasons"])


# ---------------------------------------------------------------- 임무 → 입력
def test_mission_geometry(short_mission):
    g = mission_geometry(short_mission)
    assert g["total_distance_m"] > g["max_dist_home_m"] > 0
    assert g["max_alt_m"] == 50.0 and g["hover_time_s"] == 20.0
    no_rth = MissionInput.from_dict({**short_mission.to_dict(), "return_to_home": False})
    assert mission_geometry(no_rth)["total_distance_m"] < g["total_distance_m"]


def test_propose_for_mission_uses_profile_defaults(profiles, short_mission, calm_weather):
    r = propose_for_mission(short_mission, profiles["quad500"], calm_weather, profiles=profiles)
    assert r["inputs"]["cruise_speed_ms"] == profiles["quad500"].cruise_speed_ms
    assert r["inputs"]["motors"] == 4 and r["inputs"]["reserve_fraction"] == 0.25
    assert r["inputs"]["wind_ms"] == pytest.approx(calm_weather.hour(10).wind_at(50.0)[0])
    assert r["weather_used"]["temp_c"] == 18.0
    r2 = propose_for_mission(short_mission, profiles["quad500"], calm_weather, cruise_speed_ms=12.0, motors=6)
    assert r2["inputs"]["cruise_speed_ms"] == 12.0 and r2["inputs"]["motors"] == 6


def test_mission_input_carries_sizing_fields(short_mission):
    d = {**short_mission.to_dict(), "target_cruise_ms": 10, "motor_count": 6}
    m = MissionInput.from_dict(d)
    assert m.target_cruise_ms == 10.0 and m.motor_count == 6
    assert MissionInput.from_dict(short_mission.to_dict()).target_cruise_ms is None
    assert MissionInput.from_dict({**d, "target_cruise_ms": ""}).target_cruise_ms is None


# ---------------------------------------------------------------- API
@pytest.fixture
def api(monkeypatch):
    monkeypatch.setattr(api_mod, "fetch_weather", lambda lat, lon, date: make_weather(date=date))
    return api_mod.Api()


def test_simulate_includes_sizing(api, short_mission):
    res = api.simulate(short_mission.to_dict(), n_runs=20)
    assert "error" not in res
    sz = res["sizing"]
    assert "error" not in sz
    assert sz["summary"]["frame_class"] in ("450", "550") and sz["summary"]["recommended_profile_id"] == "quad500"
    json.dumps(res, ensure_ascii=False)


def test_propose_hardware_api(api, short_mission):
    res = api.propose_hardware(short_mission.to_dict(), {"cruise_speed_ms": 10, "motors": 6})
    assert "error" not in res, res
    assert res["inputs"]["cruise_speed_ms"] == 10.0 and res["inputs"]["motors"] == 6
    assert res["weather_source"]["used"] == "forecast" and res["profile_id"] == "quad500"
    assert res["geometry"]["total_distance_m"] > 0
    assert "error" in api.propose_hardware({"waypoints": [], "date": "2026-10-18"})
    assert "모터 수" in api.propose_hardware(short_mission.to_dict(), {"motors": 5})["error"]
