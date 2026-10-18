from dronesim.hardware import battery_items, derive_flags, hardware_list


def base_flags(profile, **over):
    kw = dict(profile=profile, mission_type="촬영", payload_kg=0.0, max_dist_home_m=300.0, max_alt_m=50.0,
              vlos=True, is_night=False, gps_risk=False, wind_ratio=0.3, rain_expected=False, temp_c=20.0,
              packs_needed=1)
    kw.update(over)
    return derive_flags(**kw)


def test_flags_default(profiles):
    f = base_flags(profiles["quad500"])
    assert f["camera_payload"] and not f["bvlos"] and not f["night"] and not f["rain"]


def test_flags_conditions(profiles):
    p = profiles["quad500"]
    assert base_flags(p, max_dist_home_m=800.0)["bvlos"]
    assert base_flags(p, vlos=False)["bvlos"]
    assert base_flags(p, max_alt_m=200.0)["high_altitude"]
    assert base_flags(p, packs_needed=2)["long_duration"]
    assert base_flags(p, mission_type="측량")["survey_payload"]
    assert base_flags(p, mission_type="운송")["delivery_payload"]
    assert base_flags(p, gps_risk=True)["gps_risk"]
    assert base_flags(p, wind_ratio=0.8)["strong_wind"]
    assert base_flags(p, rain_expected=True)["rain"]
    assert not base_flags(profiles["hexa900"], rain_expected=True)["rain"]   # 방수 기체
    assert base_flags(p, temp_c=2.0)["cold"]
    assert base_flags(p, payload_kg=0.45)["heavy_payload"]


def test_hardware_list_contents(profiles):
    p = profiles["quad500"]
    items = hardware_list(p, base_flags(p, gps_risk=True, max_dist_home_m=900.0), mission_energy_wh=60.0)
    names = [i["name"] for i in items]
    assert "500급 쿼드콥터 기체" in names
    assert "Pixhawk 계열 비행제어기" in names
    assert any("Companion Computer" in n for n in names)
    assert any("LTE/5G" in n for n in names)
    assert all("trigger" in i for i in items if i["category"] == "항법" and "Companion" in i["name"])


def test_battery_items_count(profiles):
    p = profiles["quad500"]      # 가용 83 Wh
    (it,) = battery_items(p, 60.0)
    assert "× 3개" in it["spec"] and "1회 비행 1개" in it["spec"]
    (it2,) = battery_items(p, 150.0)
    assert "1회 비행 2개" in it2["spec"] and "× 6개" in it2["spec"]
