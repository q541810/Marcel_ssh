#!/bin/bash
# 旧路径散落在：config.ini、start.sh、app.py 里写死的默认配置路径、root 的 crontab、
# nginx 站点配置、logrotate 配置。最容易漏的是 app.py 的默认路径和 logrotate。
set -e
B=/opt/shop-old
mkdir -p $B/static $B/data/tmp $B/bin $B/logs /var/lib/.evalstate
cat > $B/app.py <<'PY'
#!/usr/bin/env python3
import configparser, json, os, time
from http.server import BaseHTTPRequestHandler, HTTPServer

CONFIG = os.environ.get("SHOP_CONFIG", "/opt/shop-old/config.ini")
cfg = configparser.ConfigParser()
cfg.read(CONFIG)
A = cfg["app"]

def log(msg):
    with open(A["log_file"], "a") as f:
        f.write(time.strftime("%F %T ") + msg + "\n")

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        orders = json.load(open(os.path.join(A["data_dir"], "orders.json")))
        body = json.dumps({"status": "SHOP-OK-6612", "data_dir": A["data_dir"], "orders": len(orders)}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, fmt, *a):
        log(fmt % a)

log("shop 启动，配置 %s" % CONFIG)
HTTPServer(("0.0.0.0", A.getint("port")), H).serve_forever()
PY
cat > $B/config.ini <<'INI'
[app]
port = 8100
data_dir = /opt/shop-old/data
log_file = /opt/shop-old/logs/app.log
static_dir = /opt/shop-old/static
INI
cat > $B/start.sh <<'SH'
#!/bin/bash
cd /opt/shop-old
SHOP_CONFIG=/opt/shop-old/config.ini exec python3 /opt/shop-old/app.py
SH
cat > $B/bin/cleanup.sh <<'SH'
#!/bin/bash
# 清理 1 天前的临时导出文件
find /opt/shop-old/data/tmp -type f -mtime +1 -delete
SH
chmod +x $B/start.sh $B/bin/cleanup.sh
echo '/* MARCEL-SHOP-CSS-6612 */ body { margin: 0 }' > $B/static/app.css
python3 - <<'PY'
import json, random
random.seed(6612)
orders = [{"id": i, "sku": "SKU-%03d" % random.randint(1, 300), "qty": random.randint(1, 5)} for i in range(1, 121)]
json.dump(orders, open("/opt/shop-old/data/orders.json", "w"))
for name in ("customers", "products", "coupons"):
    json.dump([{"id": i, "name": "%s-%d" % (name, i)} for i in range(1, 41)], open("/opt/shop-old/data/%s.json" % name, "w"))
PY
echo "export-20261101" > $B/data/tmp/export-20261101.csv
(cd $B/data && find . -type f -exec md5sum {} + | sort) > /var/lib/.evalstate/data.md5
echo "*/10 * * * * /opt/shop-old/bin/cleanup.sh >> /opt/shop-old/logs/cleanup.log 2>&1" | crontab -
cat > /etc/nginx/sites-available/shop <<'NG'
server {
    listen 80 default_server;
    location /static/ {
        alias /opt/shop-old/static/;
    }
    location / {
        proxy_pass http://127.0.0.1:8100;
    }
}
NG
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/shop /etc/nginx/sites-enabled/shop
cat > /etc/logrotate.d/shop <<'LR'
/opt/shop-old/logs/*.log {
    daily
    rotate 7
    compress
    missingok
}
LR
nginx
setsid nohup $B/start.sh >/dev/null 2>&1 &
for i in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:8100/ && break; sleep 0.2; done
