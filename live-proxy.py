#!/usr/bin/env python3
"""
Tiny local CORS proxy for the SPCX mission board site.

Why this exists:
  Public free CORS relays (allorigins, corsproxy.io, etc.) are unreliable —
  they get overloaded or restrict their free tier without warning. Running
  this on your own machine removes that dependency entirely: your browser
  talks to localhost, and this script talks to Yahoo Finance directly.

Requirements:
  Python 3 only. No pip installs, no account, no API key.

How to run:
  1. Open a terminal in this folder.
  2. Run:  python3 live-proxy.py
  3. Leave that terminal window open.
  4. Open spacex-stock.html in your browser as usual — the page will
     automatically detect and prefer this local proxy over the public ones.
  5. Press Ctrl+C in the terminal to stop it whenever you're done.

This proxy only forwards requests to Yahoo Finance's public quote endpoint
(query1.finance.yahoo.com) — nothing else, and nothing is stored or logged
beyond what your terminal prints.
"""

import json
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs, unquote

PORT = 8899
ALLOWED_HOST = "query1.finance.yahoo.com"


class ProxyHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("[live-proxy]", fmt % args)

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path != "/proxy":
            self.send_response(404)
            self._cors_headers()
            self.end_headers()
            self.wfile.write(b'{"error":"not found. use /proxy?url=..."}')
            return

        qs = parse_qs(parsed.query)
        target = qs.get("url", [None])[0]
        if not target:
            self.send_response(400)
            self._cors_headers()
            self.end_headers()
            self.wfile.write(b'{"error":"missing url parameter"}')
            return

        target = unquote(target)
        target_host = urlparse(target).netloc

        if target_host != ALLOWED_HOST:
            self.send_response(403)
            self._cors_headers()
            self.end_headers()
            self.wfile.write(json.dumps({
                "error": f"this proxy only forwards to {ALLOWED_HOST}"
            }).encode())
            return

        try:
            req = urllib.request.Request(
                target,
                headers={"User-Agent": "Mozilla/5.0 (compatible; live-proxy/1.0)"}
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                body = resp.read()
            self.send_response(200)
            self._cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self.send_response(502)
            self._cors_headers()
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())


if __name__ == "__main__":
    server = HTTPServer(("localhost", PORT), ProxyHandler)
    print(f"Live proxy running at http://localhost:{PORT}")
    print(f"Forwarding only to {ALLOWED_HOST}. Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
