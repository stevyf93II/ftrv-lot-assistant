#!/usr/bin/env python3
"""FTRV Lot Assistant – local proxy server.
Serves the HTML app AND forwards:
  /api/chat        → Anthropic API
  /api/floorplan   → fetches funtownrv.com product page, extracts floor plan image
  /api/cross-store → live cross-FTRV-store inventory fan-out for the Lot Tool's
                     sales-pro cross-store toggle (Cleburne, Waco, Dallas, etc.)
                     NEVER persisted; data stays in this Render service only.
  /api/health      → tiny ping endpoint used to wake Render free-tier cold-start

CORS is enabled so file:// HTML pages can call these endpoints.
"""
import json, os, re, ssl, time, urllib.request, urllib.parse, socket
from http.server import HTTPServer, SimpleHTTPRequestHandler
from concurrent.futures import ThreadPoolExecutor, as_completed

API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
PORT = int(os.environ.get('PORT', 8765))
BOOT_TIME = time.time()

CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
}

# ─── CROSS-STORE configuration ────────────────────────────────────────────
# All 9 non-Texarkana FTRV stores. Texarkana is excluded since it's already
# the canonical source served by arklatexrv.com/inventory.json. The URL
# pattern is funtownrv.com/locations/<slug>/<condition>-rv-sales-<slug>.
STORES = [
    'cleburne', 'waco', 'dallas', 'houston', 'weatherford',
    'hempstead', 'alvarado', 'winstar', 'katy',
]
CROSS_STORE_CACHE = {}     # key: (store, condition) → (timestamp, units list)
CROSS_STORE_TTL = 30 * 60  # 30 minutes

LISTING_CARD_RE = re.compile(
    r'<li[^>]*?data-unitid="(\d+)"[^>]*?data-productid="(\d+)"[^>]*?>(.*?)</li>',
    re.DOTALL,
)
HREF_PRODUCT_RE = re.compile(r'href="(/product/[^"]*?-(\d+)-(\d+))"')
TITLE_RE = re.compile(r'<h\d[^>]*>(.*?)</h\d>', re.DOTALL)
PRICE_RE = re.compile(r'\$\s?([\d,]+)')


def _parse_listing_units(html):
    """Extract unit cards from a FTRV listing page. Returns list of dicts."""
    seen = {}
    for m in LISTING_CARD_RE.finditer(html):
        uid, pid, body = m.group(1), m.group(2), m.group(3)
        title_m = TITLE_RE.search(body)
        price_m = PRICE_RE.search(body)
        title = re.sub(r'<[^>]+>', '', title_m.group(1)).strip() if title_m else None
        price = int(price_m.group(1).replace(',', '')) if price_m else None
        seen[(uid, pid)] = {
            'unit_id': uid,
            'product_id': pid,
            'title': title,
            'sale_price': price,
            'url': f'https://www.funtownrv.com/product/rv-{uid}-{pid}',
        }
    # Fallback for cards that don't have data-unitid attrs
    for m in HREF_PRODUCT_RE.finditer(html):
        uid, pid = m.group(2), m.group(3)
        if (uid, pid) not in seen:
            seen[(uid, pid)] = {
                'unit_id': uid,
                'product_id': pid,
                'title': None,
                'sale_price': None,
                'url': 'https://www.funtownrv.com' + m.group(1),
            }
    return list(seen.values())


def _fetch_listing(store, condition, pagesize=250, ttl=CROSS_STORE_TTL):
    """Fetch + parse one store's listing page for one condition. Cached."""
    cache_key = (store, condition)
    now = time.time()
    cached = CROSS_STORE_CACHE.get(cache_key)
    if cached and (now - cached[0]) < ttl:
        return cached[1]

    url = f'https://www.funtownrv.com/locations/{store}/{condition}-rv-sales-{store}?pagesize={pagesize}'
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, context=ctx, timeout=15) as resp:
        html = resp.read().decode('utf-8', errors='ignore')

    units = _parse_listing_units(html)
    for u in units:
        u['condition'] = condition
        u['store'] = store
    CROSS_STORE_CACHE[cache_key] = (now, units)
    return units


class Handler(SimpleHTTPRequestHandler):

    def _send_cors(self):
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith('/api/health'):
            self._handle_health()
        elif self.path.startswith('/api/floorplan'):
            self._handle_floorplan()
        elif self.path.startswith('/api/cross-store'):
            self._handle_cross_store()
        else:
            super().do_GET()

    def _handle_health(self):
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

            m = re.search(r'unit_tech_drawing/(?!small/)unit_tech_drawing_[^"\'?\s]+', html)
            if m:
                fp_url = 'https://assets-cdn.interactcp.com/interactrv/' + m.group(0)
                self._json(200, {'floorplanUrl': fp_url})
            else:
                self._json(200, {'floorplanUrl': None})
        except Exception as e:
            self._json(500, {'error': str(e)})

    def _handle_cross_store(self):
        """Fan out to FTRV listing pages for the requested stores. Returns
        aggregated units. Cached per (store, condition) for 30 minutes."""
        try:
            qs = urllib.parse.urlparse(self.path).query
            params = urllib.parse.parse_qs(qs)
            condition = params.get('condition', ['both'])[0].lower()
            if condition not in ('new', 'used', 'both'):
                condition = 'both'
            stores_param = params.get('stores', [None])[0]
            if stores_param:
                stores = [s.strip() for s in stores_param.split(',') if s.strip() in STORES]
                if not stores:
                    stores = list(STORES)
            else:
                stores = list(STORES)
            pagesize = int(params.get('pagesize', ['250'])[0])
            conditions = ['new', 'used'] if condition == 'both' else [condition]

            # Fan out: one task per (store, condition). Up to 18 tasks, run with
            # modest concurrency so we don't hammer funtownrv.com.
            results = {s: {'count': 0, 'units': [], 'errors': []} for s in stores}
            tasks = [(s, c) for s in stores for c in conditions]

            with ThreadPoolExecutor(max_workers=6) as ex:
                future_to_task = {
                    ex.submit(_fetch_listing, s, c, pagesize): (s, c)
                    for (s, c) in tasks
                }
                for fut in as_completed(future_to_task):
                    s, c = future_to_task[fut]
                    try:
                        units = fut.result()
                        # Dedup units across new+used (rare but possible)
                        existing = {(u['unit_id'], u['product_id']) for u in results[s]['units']}
                        for u in units:
                            if (u['unit_id'], u['product_id']) not in existing:
                                results[s]['units'].append(u)
                                existing.add((u['unit_id'], u['product_id']))
                    except Exception as e:
                        results[s]['errors'].append({
                            'condition': c,
                            'error': str(e)[:200],
                        })

            for s in results:
                results[s]['count'] = len(results[s]['units'])

            total = sum(r['count'] for r in results.values())
            self._json(200, {
                'condition': condition,
                'stores_queried': stores,
                'total_units': total,
                'cache_age_sec': None,  # mixed across stores; per-store recency in results
                'results': results,
            })
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
        pass

os.chdir(os.path.dirname(os.path.abspath(__file__)))

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
