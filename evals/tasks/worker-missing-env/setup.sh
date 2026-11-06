#!/bin/bash
set -e
mkdir -p /opt/worker
cat > /opt/worker/worker.py <<'PY'
#!/usr/bin/env python3
import os, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
LOG = "/var/log/worker.log"

def log(msg):
    with open(LOG, "a") as f:
        f.write(time.strftime("%F %T ") + msg + "\n")

def load_env():
    p = os.path.join(HERE, ".env")
    if os.path.exists(p):
        for line in open(p):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())

load_env()
for key in ("WORKER_NAME", "WORKER_QUEUE_URL"):
    if not os.environ.get(key):
        log("FATAL: 缺少必需的环境变量 %s，退出" % key)
        sys.exit(1)
if os.environ["WORKER_QUEUE_URL"] != "memory://eval-queue-01":
    log("FATAL: WORKER_QUEUE_URL 的值无效：%s" % os.environ["WORKER_QUEUE_URL"])
    sys.exit(1)

log("worker %s 启动，队列 %s" % (os.environ["WORKER_NAME"], os.environ["WORKER_QUEUE_URL"]))
while True:
    time.sleep(2)
    log("heartbeat worker-ok-4471")
PY
echo "WORKER_NAME=w1" > /opt/worker/.env
cat > /opt/worker/README <<'C'
worker 配置说明
===============
所有配置通过环境变量提供，也可以写在同目录的 .env 里（KEY=VALUE 每行一个）。

WORKER_NAME       本 worker 的名字，例如 w1
WORKER_QUEUE_URL  任务队列地址，本机测试环境固定用：memory://eval-queue-01

启动：python3 /opt/worker/worker.py
日志：/var/log/worker.log
C
rm -f /var/log/worker.log
python3 /opt/worker/worker.py || true
