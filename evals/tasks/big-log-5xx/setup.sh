#!/bin/bash
set -e
mkdir -p /var/log/nginx-big /var/lib/.evalstate
python3 - <<'PY'
import random, datetime
random.seed(20260101)
now = datetime.datetime.now()
today = now.replace(hour=0, minute=0, second=0, microsecond=0)
days = [today - datetime.timedelta(days=k) for k in (3, 2, 1, 0)]  # 大前天,前天,昨天,今天
yesterday = days[2]
paths = ["/", "/index.html", "/api/v1/search", "/api/v1/items", "/api/v1/items/42", "/api/v2/users/profile",
         "/api/v2/orders/list", "/api/v2/orders/checkout", "/static/app.js", "/static/app.css", "/healthz",
         "/login", "/logout", "/api/v2/cart"]
uas = ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
       "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
       "curl/8.5.0", "python-requests/2.31.0", "Go-http-client/2.0"]
ok_status = [200] * 90 + [304] * 5 + [301] * 2 + [404] * 2 + [499]
def rline(t, path, status):
    ip = "10.%d.%d.%d" % (random.randint(0, 255), random.randint(0, 255), random.randint(1, 254))
    q = ""
    if path.startswith("/api") and random.random() < 0.5:
        q = "?id=%d&t=%d" % (random.randint(1, 99999), random.randint(1, 9999))
    ts = t.strftime("%d/%b/%Y:%H:%M:%S +0800")
    size = random.randint(120, 20000)
    return '%s - - [%s] "GET %s%s HTTP/1.1" %d %d "-" "%s" rt=%.3f' % (
        ip, ts, path, q, status, size, random.choice(uas), random.random() * 2)
out = []
for day in days:
    lines = []
    for _ in range(70000):
        t = day + datetime.timedelta(seconds=random.randint(0, 86399))
        lines.append((t, random.choice(paths), random.choice(ok_status)))
    inj = {}
    if day == yesterday:
        inj = {"/api/v2/orders/checkout": 1847, "/api/v2/users/profile": 412, "/api/v1/search": 305,
               "/healthz": 61, "/api/v2/cart": 33, "/login": 7}
    elif day == days[1]:
        inj = {"/api/v1/search": 2600, "/api/v2/orders/checkout": 140}  # 前天的干扰
    elif day == days[3]:
        inj = {"/api/v1/search": 900, "/api/v2/users/profile": 500}      # 今天的干扰
    else:
        inj = {"/api/v1/items": 700}
    for p, n in inj.items():
        for _ in range(n):
            t = day + datetime.timedelta(seconds=random.randint(0, 86399))
            lines.append((t, p, random.choice([500, 500, 502, 503, 504])))
    lines.sort(key=lambda x: x[0])
    out.extend(rline(t, p, s) for t, p, s in lines)
with open("/var/log/nginx-big/access.log", "w") as f:
    f.write("\n".join(out) + "\n")
PY
md5sum /var/log/nginx-big/access.log > /var/lib/.evalstate/biglog.md5
