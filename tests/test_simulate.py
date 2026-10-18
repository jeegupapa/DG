from dronesim.models import MissionInput
from dronesim.simulate import FAIL, OK, WARN, capacity_factor_for_temp, evaluate, monte_carlo, run_mission
from tests.conftest import make_weather


def check(run, key):
    return next(c for c in run.checks if c.key == key)


def test_calm_short_mission_ok(profiles, short_mission, calm_weather):
    r = run_mission(short_mission, profiles["quad500"], calm_weather)
    assert r.overall == OK, [c for c in r.checks if c.status != OK]
    assert r.total_time_s > 0 and r.total_energy_wh > 0
    assert r.battery_used_frac < 0.5
    kinds = [s.kind for s in r.segments]
    assert kinds[0] == "takeoff" and kinds[-1] == "land" and "return" in kinds and "hover" in kinds


def test_strong_wind_fails(profiles, short_mission):
    wd = make_weather(wind10=9.0, wind_alt=11.0, gust=15.0)
    r = run_mission(short_mission, profiles["quad500"], wd)
    assert check(r, "wind").status == FAIL
    assert check(r, "gust").status == FAIL
    assert r.overall == FAIL and "풍속(비행 고도)" in r.failures


def test_headwind_makes_route_unflyable(profiles):
    # 동서로 긴 왕복 경로 + 순항속도(8)보다 강한 서풍 → 서향 복귀 구간 유지 불가
    m = MissionInput.from_dict({
        "waypoints": [{"lat": 36.35, "lon": 127.38, "alt_m": 50}, {"lat": 36.35, "lon": 127.40, "alt_m": 50}],
        "date": "2026-10-18", "time": "10:00", "profile_id": "quad500",
    })
    wd = make_weather(wind10=5.0, wind_alt=9.0, wind_dir=270.0, gust=9.0)
    r = run_mission(m, profiles["quad500"], wd)
    assert check(r, "control").status == FAIL
    ret = next(s for s in r.segments if s.kind == "return")
    assert ret.status == FAIL


def test_rain_fails_for_non_waterproof_only(profiles, short_mission):
    wd = make_weather(precip=1.2, precip_prob=90.0)
    assert check(run_mission(short_mission, profiles["quad500"], wd), "precip").status == FAIL
    m2 = MissionInput.from_dict({**short_mission.to_dict(), "profile_id": "hexa900"})
    assert check(run_mission(m2, profiles["hexa900"], wd), "precip").status == WARN


def test_night_requires_approval_and_capability(profiles, short_mission, calm_weather):
    m = MissionInput.from_dict({**short_mission.to_dict(), "time": "21:00"})
    assert check(run_mission(m, profiles["quad500"], calm_weather), "daylight").status == FAIL
    m2 = MissionInput.from_dict({**m.to_dict(), "night_approved": True})
    assert check(run_mission(m2, profiles["quad500"], calm_weather), "daylight").status == FAIL  # 조명 없는 기체
    m3 = MissionInput.from_dict({**m.to_dict(), "night_approved": True, "profile_id": "hexa900"})
    assert check(run_mission(m3, profiles["hexa900"], calm_weather), "daylight").status == WARN


def test_long_mission_exceeds_battery(profiles, calm_weather):
    m = MissionInput.from_dict({
        "waypoints": [{"lat": 36.35, "lon": 127.38, "alt_m": 50}, {"lat": 36.42, "lon": 127.38, "alt_m": 50}],
        "date": "2026-10-18", "time": "10:00", "profile_id": "quad500", "vlos": False,
    })
    r = run_mission(m, profiles["quad500"], calm_weather)
    assert check(r, "battery").status == FAIL
    assert check(r, "range").status == FAIL      # 7.8 km > 텔레메트리 2 km


def test_vlos_range_warning(profiles, calm_weather):
    m = MissionInput.from_dict({
        "waypoints": [{"lat": 36.35, "lon": 127.38, "alt_m": 50}, {"lat": 36.357, "lon": 127.38, "alt_m": 50}],
        "date": "2026-10-18", "time": "10:00", "profile_id": "quad500",
    })
    assert check(run_mission(m, profiles["quad500"], calm_weather), "range").status == WARN


def test_altitude_checks(profiles, short_mission, calm_weather):
    d = short_mission.to_dict()
    for w in d["waypoints"]:
        w["alt_m"] = 160
    r = run_mission(MissionInput.from_dict(d), profiles["quad500"], calm_weather)
    assert check(r, "altitude").status == FAIL  # 프로필 최대 150 m


def test_temperature_capacity():
    assert capacity_factor_for_temp(20.0) == 1.0
    assert abs(capacity_factor_for_temp(-10.0) - 0.75) < 1e-9
    assert capacity_factor_for_temp(None) == 1.0


def test_cold_reduces_usable(profiles, short_mission):
    warm = run_mission(short_mission, profiles["quad500"], make_weather(temp=20.0))
    cold = run_mission(short_mission, profiles["quad500"], make_weather(temp=-5.0))
    assert cold.usable_wh < warm.usable_wh
    assert check(cold, "temp").status == WARN


def test_monte_carlo_deterministic_and_bounded(profiles, short_mission, calm_weather):
    a = monte_carlo(short_mission, profiles["quad500"], calm_weather, n_runs=100, seed=1)
    b = monte_carlo(short_mission, profiles["quad500"], calm_weather, n_runs=100, seed=1)
    assert a == b
    assert 0.0 <= a["success_probability"] <= 1.0
    assert a["battery_used_p10"] <= a["battery_used_p50"] <= a["battery_used_p90"]


def test_evaluate_shape(profiles, short_mission, calm_weather):
    r = evaluate(short_mission, profiles["quad500"], calm_weather, n_runs=50)
    assert r["verdict"] in ("가능", "주의", "불가")
    for k in ("nominal", "monte_carlo", "hardware", "flags", "weather", "weather_at_start", "profile", "mission"):
        assert k in r
    assert any(h["category"] == "전원" and "배터리" in h["name"] for h in r["hardware"])
    assert r["weather"]["hours"][0]["wind_levels"]["10"] == [3.0, 270.0]


def test_archive_weather_marks_visibility_info(profiles, short_mission):
    r = run_mission(short_mission, profiles["quad500"], make_weather(source="archive"))
    assert check(r, "vis").status == "info"
    assert r.overall == OK


def test_segments_carry_positions_for_3d_playback(profiles, short_mission, calm_weather):
    r = run_mission(short_mission, profiles["quad500"], calm_weather)
    home = short_mission.waypoints[0]
    for s in r.segments:
        assert s.from_pos is not None and s.to_pos is not None and len(s.from_pos) == 3
    assert r.segments[0].from_pos == [home.lat, home.lon, 0.0]
    assert r.segments[0].to_pos == [home.lat, home.lon, home.alt_m]
    ret = next(s for s in r.segments if s.kind == "return")
    assert ret.to_pos[:2] == [home.lat, home.lon]
    land = r.segments[-1]
    assert land.from_pos[:2] == [home.lat, home.lon] and land.to_pos[2] == 0.0
    # 구간은 시간순으로 이어진다
    for a, b in zip(r.segments, r.segments[1:]):
        assert abs((a.start_s + a.time_s) - b.start_s) < 1e-6
