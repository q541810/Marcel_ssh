#!/bin/bash
code=$(curl -s -o /tmp/_idx -w '%{http_code}' --max-time 5 http://127.0.0.1/ 2>/dev/null || true)
if [ "$code" != "200" ]; then echo "首页没有返回 200（实际 ${code:-无响应}）"; exit 1; fi
if ! grep -q 'MARCEL-SITE-OK-7731' /tmp/_idx; then echo "首页返回 200 但内容不对"; exit 1; fi
if ! grep -q 'MARCEL-SITE-OK-7731' /var/www/site/index.html; then echo "index.html 被改动了"; exit 1; fi
echo "首页返回 200 且内容正确"
