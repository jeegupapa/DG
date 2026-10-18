import json

from dronesim.export import (FIRMWARE_ARDUPILOT, FIRMWARE_PX4, MAV_CMD_NAV_RETURN_TO_LAUNCH, MAV_CMD_NAV_TAKEOFF,
                             MAV_CMD_NAV_WAYPOINT, mission_planner_waypoints, qgc_plan, qgc_plan_text)


def test_qgc_plan_structure(profiles, short_mission):
    plan = qgc_plan(short_mission, profiles["quad500"])
    assert plan["fileType"] == "Plan" and plan["version"] == 1
    items = plan["mission"]["items"]
    assert items[0]["command"] == MAV_CMD_NAV_TAKEOFF
    assert [i["command"] for i in items[1:4]] == [MAV_CMD_NAV_WAYPOINT] * 3
    assert items[-1]["command"] == MAV_CMD_NAV_RETURN_TO_LAUNCH
    assert items[2]["params"][0] == 20.0                       # 체공 시간
    assert [i["doJumpId"] for i in items] == list(range(1, len(items) + 1))
    assert plan["mission"]["firmwareType"] == FIRMWARE_ARDUPILOT
    assert qgc_plan(short_mission, profiles["quad500"], "px4")["mission"]["firmwareType"] == FIRMWARE_PX4
    assert plan["mission"]["plannedHomePosition"][:2] == [36.35, 127.38]
    json.loads(qgc_plan_text(short_mission, profiles["quad500"]))


def test_waypoints_text(short_mission):
    txt = mission_planner_waypoints(short_mission)
    lines = txt.strip().splitlines()
    assert lines[0] == "QGC WPL 110"
    rows = [l.split("\t") for l in lines[1:]]
    assert len(rows) == 1 + 1 + 3 + 1                            # home, takeoff, 3 wp, RTL
    assert rows[0][1] == "1"                                     # home is current
    assert rows[1][3] == str(MAV_CMD_NAV_TAKEOFF)
    assert rows[-1][3] == str(MAV_CMD_NAV_RETURN_TO_LAUNCH)
    assert all(len(r) == 12 for r in rows)
    assert rows[3][4] == "20.00000000"                            # hover on WP2
