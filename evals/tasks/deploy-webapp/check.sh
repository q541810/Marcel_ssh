#!/bin/bash
get() { curl -s --max-time 4 http://127.0.0.1:8000/ 2>/dev/null; }
get | grep -q 'MARCEL-WEBAPP-OK-9082' || { echo "8000 端口没有 webapp 的响应"; exit 1; }
[ -f /opt/webapp/start.sh ] || { echo "/opt/webapp/start.sh 不存在"; exit 1; }
[ -x /opt/webapp/start.sh ] || { echo "start.sh 没有可执行权限"; exit 1; }
# 杀掉现有进程，用 start.sh 重启，验证它真的能用
pkill -f 'app\.py' 2>/dev/null || true
sleep 1
if get | grep -q 'MARCEL-WEBAPP-OK-9082'; then echo "无法停掉旧进程，无法验证 start.sh"; exit 1; fi
( cd / && setsid timeout 15 /opt/webapp/start.sh >/dev/null 2>&1 & )
sleep 3
get | grep -q 'MARCEL-WEBAPP-OK-9082' || { echo "用 start.sh 重启后 8000 没有响应"; exit 1; }
echo "webapp 在 8000 正常响应，start.sh 可执行且能重新拉起服务"
