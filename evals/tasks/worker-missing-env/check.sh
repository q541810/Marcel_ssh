#!/bin/bash
pgrep -f 'worker\.py' >/dev/null || { echo "worker 进程没有在运行"; exit 1; }
n1=$(grep -c 'heartbeat worker-ok-4471' /var/log/worker.log 2>/dev/null)
sleep 5
n2=$(grep -c 'heartbeat worker-ok-4471' /var/log/worker.log 2>/dev/null)
pgrep -f 'worker\.py' >/dev/null || { echo "worker 起来后又退出了"; exit 1; }
[ "${n2:-0}" -gt "${n1:-0}" ] || { echo "worker 日志里没有持续的心跳输出"; exit 1; }
echo "worker 在后台持续运行，日志有心跳"
