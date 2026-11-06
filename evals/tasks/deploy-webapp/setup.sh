#!/bin/bash
set -e
mkdir -p /opt/webapp
cat > /opt/webapp/app.py <<'PY'
#!/usr/bin/env python3
"""简易 web 应用，只用标准库。监听 0.0.0.0:8000。"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        body = "<h1>Marcel WebApp</h1><p>MARCEL-WEBAPP-OK-9082</p>".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass

if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8000), H).serve_forever()
PY
cat > /opt/webapp/README.md <<'MD'
# webapp
纯标准库实现，无需安装依赖。运行：`python3 app.py`，监听 8000 端口。
MD
