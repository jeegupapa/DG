"""개발·검증용 HTTP 서버. 데스크톱 창 없이 일반 브라우저에서 UI를 확인할 때 쓴다.

    python -m dronesim.devserver [port]

UI는 window.pywebview가 없으면 POST /api/<메서드> 로 같은 Api를 호출한다.
"""
from __future__ import annotations

import json
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .api import Api

UI_DIR = Path(__file__).resolve().parent / "ui"
api = Api()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(UI_DIR), **kw)

    def do_POST(self):  # noqa: N802
        if not self.path.startswith("/api/"):
            self.send_error(404)
            return
        name = self.path[len("/api/"):]
        method = getattr(api, name, None)
        if method is None or name.startswith("_"):
            self.send_error(404, f"no api {name}")
            return
        length = int(self.headers.get("Content-Length", "0") or 0)
        args = json.loads(self.rfile.read(length) or b"[]")
        try:
            result = method(*args)
        except Exception as e:  # 개발 편의: 예외를 JSON으로
            result = {"error": f"{type(e).__name__}: {e}"}
        body = json.dumps(result, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"dev server: http://127.0.0.1:{port}/", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
