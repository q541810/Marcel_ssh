#!/bin/bash
r=$(curl -s --max-time 5 http://127.0.0.1:8080/ 2>/dev/null || true)
if [ -z "$r" ]; then echo "8080 端口没有响应"; exit 1; fi
if ! echo "$r" | grep -q 'MARCEL-API-OK-5521'; then echo "8080 上跑的不是 api 服务"; exit 1; fi
if ! grep -q 'MARCEL-API-OK-5521' /opt/api/server.py; then echo "server.py 被改动，特征响应丢失"; exit 1; fi
echo "8080 上是 api 服务，返回特征响应正确"
