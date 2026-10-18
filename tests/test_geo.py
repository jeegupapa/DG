import math

from dronesim.geo import bearing_deg, ground_speed_ms, haversine_m, wind_components


def test_haversine_seoul_busan():
    d = haversine_m(37.5665, 126.9780, 35.1796, 129.0756)
    assert 320_000 < d < 330_000


def test_haversine_zero():
    assert haversine_m(36.35, 127.38, 36.35, 127.38) == 0.0


def test_bearing_cardinal():
    assert abs(bearing_deg(36.0, 127.0, 37.0, 127.0) - 0.0) < 0.01       # 북
    assert abs(bearing_deg(36.0, 127.0, 36.0, 128.0) - 90.0) < 0.5       # 동
    assert abs(bearing_deg(36.0, 127.0, 35.0, 127.0) - 180.0) < 0.01     # 남


def test_wind_components_tailwind_headwind():
    # 서풍(270에서 불어옴)은 동쪽으로 흐른다. 동쪽(90) 진행이면 뒷바람.
    along, cross = wind_components(5.0, 270.0, 90.0)
    assert math.isclose(along, 5.0, abs_tol=1e-9) and abs(cross) < 1e-9
    # 서쪽(270) 진행이면 맞바람
    along, cross = wind_components(5.0, 270.0, 270.0)
    assert math.isclose(along, -5.0, abs_tol=1e-9)
    # 북쪽(0) 진행이면 순수 측풍
    along, cross = wind_components(5.0, 270.0, 0.0)
    assert abs(along) < 1e-9 and math.isclose(abs(cross), 5.0, abs_tol=1e-9)


def test_ground_speed():
    assert math.isclose(ground_speed_ms(8.0, 3.0, 0.0), 11.0)
    assert math.isclose(ground_speed_ms(8.0, -3.0, 0.0), 5.0)
    assert ground_speed_ms(8.0, 0.0, 9.0) is None            # 측풍이 순항속도 초과
    assert ground_speed_ms(8.0, -9.0, 0.0) is None           # 맞바람이 순항속도 초과
    gs = ground_speed_ms(8.0, 0.0, 6.0)
    assert math.isclose(gs, math.sqrt(64 - 36))
