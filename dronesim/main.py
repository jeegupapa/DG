"""Windows 데스크톱 진입점: WebView2 창에 지도 UI를 띄운다."""
from __future__ import annotations

import sys
from pathlib import Path

import webview

from .api import Api


def resource_root() -> Path:
    """소스 실행과 PyInstaller 단일 실행파일 모두에서 리소스 경로를 돌려준다."""
    base = getattr(sys, "_MEIPASS", None)
    if base:
        return Path(base) / "dronesim"
    return Path(__file__).resolve().parent


def run() -> None:
    api = Api()
    index = resource_root() / "ui" / "index.html"
    window = webview.create_window(
        "드론 임무 시뮬레이터",
        str(index),
        js_api=api,
        width=1480,
        height=920,
        min_size=(1100, 700),
        text_select=True,
    )
    api._window = window
    webview.start(debug="--debug" in sys.argv, http_server=True)


if __name__ == "__main__":
    run()
