import pytest

from dronesim.models import MissionInput, WeatherDay, WeatherHour
from dronesim.simulate import load_profiles


def make_weather(*, wind10=3.0, wind_alt=5.0, wind_dir=270.0, gust=6.0, temp=18.0, precip=0.0,
                 precip_prob=10.0, vis=20000.0, date="2026-10-18", source="forecast",
                 sunrise="06:45", sunset="17:55") -> WeatherDay:
    hours = [
        WeatherHour(
            time=f"{date}T{h:02d}:00", temp_c=temp, precip_mm=precip,
            precip_prob=None if source == "archive" else precip_prob,
            visibility_m=None if source == "archive" else vis,
            cloud_cover=30.0, gust_ms=gust,
            wind_levels={10: (wind10, wind_dir), 80: (wind_alt, wind_dir), 120: (wind_alt + 1.0, wind_dir)},
        )
        for h in range(24)
    ]
    return WeatherDay(source, 36.35, 127.38, "Asia/Seoul", date,
                      f"{date}T{sunrise}", f"{date}T{sunset}", hours)


@pytest.fixture(autouse=True)
def isolated_config(monkeypatch, tmp_path):
    """테스트가 사용자 설정파일·환경변수 인증키에 영향받지 않도록 격리한다."""
    monkeypatch.delenv("KMA_SERVICE_KEY", raising=False)
    monkeypatch.setenv("DRONESIM_CONFIG_DIR", str(tmp_path / "cfg"))
    return tmp_path / "cfg"


@pytest.fixture
def profiles():
    return load_profiles()


@pytest.fixture
def calm_weather():
    return make_weather()


@pytest.fixture
def short_mission():
    return MissionInput.from_dict({
        "waypoints": [
            {"lat": 36.3500, "lon": 127.3800, "alt_m": 50},
            {"lat": 36.3530, "lon": 127.3830, "alt_m": 50, "hover_s": 20},
            {"lat": 36.3520, "lon": 127.3780, "alt_m": 50},
        ],
        "date": "2026-10-18", "time": "10:00", "profile_id": "quad500", "mission_type": "촬영",
    })
