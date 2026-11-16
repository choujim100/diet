"""Serve the web app on http://localhost:8765 with caching switched off,
so a browser never keeps an old copy of the scripts.

    python tools/serve.py
"""
import functools
import http.server
import pathlib

WEB = pathlib.Path(__file__).resolve().parent.parent / "web"
PORT = 8765


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    handler = functools.partial(NoCache, directory=str(WEB))
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler) as srv:
        print(f"Eat Better running at http://localhost:{PORT}  (Ctrl+C to stop)")
        srv.serve_forever()
