"""임무 파일 내보내기: QGroundControl .plan, Mission Planner .waypoints."""
from __future__ import annotations

import json
from typing import Any

from .models import AircraftProfile, MissionInput

MAV_CMD_NAV_WAYPOINT = 16
MAV_CMD_NAV_RETURN_TO_LAUNCH = 20
MAV_CMD_NAV_TAKEOFF = 22
FRAME_GLOBAL_RELATIVE_ALT = 3
FRAME_MISSION = 2

FIRMWARE_ARDUPILOT = 12
FIRMWARE_PX4 = 3


def qgc_plan(mission: MissionInput, profile: AircraftProfile, firmware: str = "ardupilot") -> dict[str, Any]:
    if not mission.waypoints:
        raise ValueError("웨이포인트가 없습니다.")
    home = mission.waypoints[0]
    items: list[dict[str, Any]] = []
    jump = 1

    def simple(command: int, params: list[Any], frame: int, alt: float | None) -> dict[str, Any]:
        nonlocal jump
        d = {
            "AMSLAltAboveTerrain": None,
            "Altitude": alt,
            "AltitudeMode": 1,
            "autoContinue": True,
            "command": command,
            "doJumpId": jump,
            "frame": frame,
            "params": params,
            "type": "SimpleItem",
        }
        jump += 1
        return d

    items.append(simple(MAV_CMD_NAV_TAKEOFF, [15, 0, 0, None, home.lat, home.lon, home.alt_m],
                        FRAME_GLOBAL_RELATIVE_ALT, home.alt_m))
    for wp in mission.waypoints:
        items.append(simple(MAV_CMD_NAV_WAYPOINT, [wp.hover_s, 0, 0, None, wp.lat, wp.lon, wp.alt_m],
                            FRAME_GLOBAL_RELATIVE_ALT, wp.alt_m))
    if mission.return_to_home:
        items.append(simple(MAV_CMD_NAV_RETURN_TO_LAUNCH, [0, 0, 0, 0, 0, 0, 0], FRAME_MISSION, None))

    return {
        "fileType": "Plan",
        "geoFence": {"circles": [], "polygons": [], "version": 2},
        "groundStation": "QGroundControl",
        "mission": {
            "cruiseSpeed": profile.cruise_speed_ms,
            "firmwareType": FIRMWARE_PX4 if firmware == "px4" else FIRMWARE_ARDUPILOT,
            "globalPlanAltitudeMode": 1,
            "hoverSpeed": min(5.0, profile.cruise_speed_ms),
            "items": items,
            "plannedHomePosition": [home.lat, home.lon, 0],
            "vehicleType": 2,
            "version": 2,
        },
        "rallyPoints": {"points": [], "version": 2},
        "version": 1,
    }


def qgc_plan_text(mission: MissionInput, profile: AircraftProfile, firmware: str = "ardupilot") -> str:
    return json.dumps(qgc_plan(mission, profile, firmware), indent=4, ensure_ascii=False)


def mission_planner_waypoints(mission: MissionInput) -> str:
    """Mission Planner 'QGC WPL 110' 텍스트 형식."""
    if not mission.waypoints:
        raise ValueError("웨이포인트가 없습니다.")
    home = mission.waypoints[0]
    rows: list[list[Any]] = []
    # index, current, frame, command, p1, p2, p3, p4, lat, lon, alt, autocontinue
    rows.append([0, 1, 0, MAV_CMD_NAV_WAYPOINT, 0, 0, 0, 0, home.lat, home.lon, 0, 1])
    rows.append([len(rows), 0, FRAME_GLOBAL_RELATIVE_ALT, MAV_CMD_NAV_TAKEOFF, 0, 0, 0, 0,
                 home.lat, home.lon, home.alt_m, 1])
    for wp in mission.waypoints:
        rows.append([len(rows), 0, FRAME_GLOBAL_RELATIVE_ALT, MAV_CMD_NAV_WAYPOINT, wp.hover_s, 0, 0, 0,
                     wp.lat, wp.lon, wp.alt_m, 1])
    if mission.return_to_home:
        rows.append([len(rows), 0, FRAME_GLOBAL_RELATIVE_ALT, MAV_CMD_NAV_RETURN_TO_LAUNCH,
                     0, 0, 0, 0, 0, 0, 0, 1])

    def fmt(v: Any) -> str:
        if isinstance(v, float):
            return f"{v:.8f}" if abs(v) > 1e-9 else "0"
        return str(v)

    lines = ["QGC WPL 110"]
    for r in rows:
        lines.append("\t".join(fmt(v) for v in r))
    return "\n".join(lines) + "\n"
