#!/bin/bash
# 得分点：赶走占端口的无关进程 → 8080 上是 api 服务
pgrep -f 'http.server 8080' >/dev/null && squat=1 || squat=0
r=$(curl -s --max-time 5 http://127.0.0.1:8080/ 2>/dev/null || true)
echo "$r" | grep -q 'MARCEL-API-OK-5521' && ok=1 || ok=0
[ "$squat" = 0 ] && freed=1 || freed=0
[ "$ok" = 1 ] && freed=1
echo "POINT 30 $freed 找到并停掉了占着 8080 的无关进程"
echo "POINT 70 $ok 8080 上跑的是 api 服务、返回特征响应"
grep -q 'MARCEL-API-OK-5521' /opt/api/server.py || echo "DEDUCT 40 server.py 被改动，特征响应丢失"
grep -q '8080' /opt/api/server.py || echo "DEDUCT 30 把 api 的端口改掉了（用户要的是 8080）"
