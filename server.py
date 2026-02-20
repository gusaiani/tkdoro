#!/usr/bin/env python3
import http.server, json, os, webbrowser
from pathlib import Path

DATA = Path(__file__).parent / "data.json"
PORT = 5555

class H(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/data":
            body = DATA.read_bytes() if DATA.exists() else b'{"tasks":[]}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
        else:
            super().do_GET()

    def do_POST(self):
        if self.path == "/data":
            length = int(self.headers["Content-Length"])
            DATA.write_bytes(self.rfile.read(length))
            self.send_response(204)
            self.end_headers()

    def log_message(self, *_): pass  # silence request logs

print(f"tt running at http://localhost:{PORT}")
webbrowser.open(f"http://localhost:{PORT}")
http.server.HTTPServer(("", PORT), H).serve_forever()
