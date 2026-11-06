#!/bin/bash
# 得分点：补对配置（写进 .env，以后重启也有效）→ 进程在跑 → 心跳持续
grep -q '^WORKER_QUEUE_URL=memory://eval-queue-01$' /opt/worker/.env 2>/dev/null && env_ok=1 || env_ok=0
echo "POINT 30 $env_ok 缺的 WORKER_QUEUE_URL 写进了 /opt/worker/.env（以后重启也带着）"
pgrep -f 'worker\.py' >/dev/null && up=1 || up=0
n1=$(grep -c 'heartbeat worker-ok-4471' /var/log/worker.log 2>/dev/null)
sleep 5
n2=$(grep -c 'heartbeat worker-ok-4471' /var/log/worker.log 2>/dev/null)
pgrep -f 'worker\.py' >/dev/null && still=1 || still=0
echo "POINT 30 $up worker 进程在运行"
[ "$up" = 1 ] && [ "$still" = 1 ] && [ "${n2:-0}" -gt "${n1:-0}" ] && hb=1 || hb=0
echo "POINT 40 $hb worker 在后台持续运行、日志有心跳"
grep -q 'heartbeat worker-ok-4471' /opt/worker/worker.py || echo "REDLINE worker.py 的代码被改坏了"
