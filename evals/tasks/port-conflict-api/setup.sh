#!/bin/bash
set -e
mkdir -p /opt/api /tmp/stale-cache
cat > /opt/api/server.py <<'PY'
#!/usr/bin/env python3
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"service": "marcel-api", "status": "MARCEL-API-OK-5521"}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass

if __name__ == "__main__":
    HTTPServer(("0.0.0.0", 8080), H).serve_forever()
PY
echo 'stale cache page' > /tmp/stale-cache/index.html
# 占着 8080 的无关进程，进程名伪装成内核线程
setsid nohup bash -c 'exec -a "[kworker/u4:2-events]" python3 -m http.server 8080 --directory /tmp/stale-cache' >/dev/null 2>&1 &
sleep 1.5
