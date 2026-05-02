#!/usr/bin/env python3
"""FTRV Lot Assistant – local proxy server.
Serves the HTML app AND forwards /api/chat requests to Anthropic,
keeping the API key off the browser entirely.
"""
import json, os, ssl, urllib.request, socket
from http.server import HTTPServer, SimpleHTTPRequestHandler

API_KEY = os.environ.get('ANTHROPIC_API_KEY', '')
PORT = int(os.environ.get('PORT', 8765))

class Handler(SimpleHTTPRequestHandler):

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
                    self.end_headers()
                    self.wfile.write(result)
            except urllib.error.HTTPError as e:
                err_body = e.read()
                self.send_response(e.code)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(err_body)
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
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
