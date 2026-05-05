#!/usr/bin/env python3
"""FTRV Lot Assistant – local proxy server.
Serves the HTML app AND forwards:
  /api/chat     → Anthropic API
  /api/floorplan?url=... → fetches funtownrv.com product page, extracts floor plan image
  /api/health   → tiny ping endpoint used to wake Render free-tier cold-start

CORS is enabled on /api/chat, /api/floorplan, and /api/health so the local
Grid View HTML (loaded as file:// from disk on Steve's computer) can call
these endpoints.
"""
import json, os, re, ssl, time, urllib.request, urllib.parse, socket
from http.server import HTTPServer, SimpleHTTPRequestHandler

API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
PORT = int(os.environ.get('PORT', 8765))
BOOT_TIME = time.time()

CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
}

class Handler(SimpleHTTPRequestHandler):

    def _send_cors(self):
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)

    def do_OPTIONS(self):
        # Preflight for cross-origin POSTs to /api/chat from file:// pages
        self.send_response(204)
        self._send_cors()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith('/api/health'):
            self._handle_health()
        elif self.path.startswith('/api/floorplan'):
            self._handle_floorplan()
        else:
            super().do_GET()

    def _handle_health(self):
        # Tiny endpoint used by the Grid View on page load (and by external
        # uptime monitors) to wake Render's free-tier worker before the
        # customer types anything. Keep response small and uncached.
        self._json(200, {
            'ok': True,
            'uptime_s': round(time.time() - BOOT_TIME, 1),
        })

    def _handle_floorplan(self):
        try:
            qs = urllib.parse.urlparse(self.path).query
            params = urllib.parse.parse_qs(qs)
            product_url = params.get('url', [None])[0]
            if not product_url:
                self._json(400, {'error': 'missing url param'})
                return

            ctx = ssl.create_default_context()
            req = urllib.request.Request(product_url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
                html = resp.read().decode('utf-8', errors='ignore')

            # Extract floor plan image URL (unit_tech_drawing, not /small/ variant)
            m = re.search(r'unit_tech_drawing/(?!small/)unit_tech_drawing_[^"\'?\s]+', html)
            if m:
                fp_url = 'https://assets-cdn.interactcp.com/interactrv/' + m.group(0)
                self._json(200, {'floorplanUrl': fp_url})
            else:
                self._json(200, {'floorplanUrl': None})
        except Exception as e:
            self._json(500, {'error': str(e)})

    def _json(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self._send_cors()
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path == '/api/chat':
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length)
            req = urllib.request.Request(
                'https://api.anthropic.com/v1/messages',
                data=body,
                headers={
                    'Content-Type': 'application/json',
                    'x-api-key': API_KEY,
                    'anthropic-version': '2023-06-01',
                },
                method='POST'
            )
            try:
                ctx = ssl.create_default_context()
                with urllib.request.urlopen(req, context=ctx) as resp:
                    result = resp.read()
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self._send_cors()
                    self.end_headers()
                    self.wfile.write(result)
            except urllib.error.HTTPError as e:
                err_body = e.read()
                self.send_response(e.code)
                self.send_header('Content-Type', 'application/json')
                self._send_cors()
                self.end_headers()
                self.wfile.write(err_body)
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self._send_cors()
                self.end_headers()
                self.wfile.write(json.dumps({'error': str(e)}).encode())
        else:
            super().do_POST()

    def log_message(self, fmt, *args):
        pass  # keep the console window quiet

os.chdir(os.path.dirname(os.path.abspath(__file__)))

# Find local IP so phones on the same WiFi can connect
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.connect(('8.8.8.8', 80))
    local_ip = s.getsockname()[0]
    s.close()
except Exception:
    local_ip = 'unknown'

print('=' * 55)
print('  FTRV Lot Assistant is running!')
print()
print(f'  On THIS computer:')
print(f'    http://localhost:{PORT}/ftrv_ai_assistant.html')
print()
print(f'  On your PHONE (must be on same WiFi):')
print(f'    http://{local_ip}:{PORT}/ftrv_ai_assistant.html')
print()
print('  Close this window when you are done.')
print('=' * 55)
httpd = HTTPServer(('', PORT), Handler)
httpd.serve_forever()
