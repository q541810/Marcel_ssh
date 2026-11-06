#!/bin/bash
for p in /static/app.css:MARCEL-CSS-4410 /static/img/logo.txt:MARCEL-LOGO-4410; do
  u=${p%%:*}; m=${p##*:}
  code=$(curl -s -o /tmp/_s -w '%{http_code}' --max-time 5 "http://127.0.0.1$u" 2>/dev/null || true)
  if [ "$code" != "200" ]; then echo "$u 返回 ${code:-无响应}，不是 200"; exit 1; fi
  if ! grep -q "$m" /tmp/_s; then echo "$u 内容不对"; exit 1; fi
done
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1/ 2>/dev/null || true)
if [ "$code" != "200" ]; then echo "首页不再返回 200"; exit 1; fi
if ! grep -q 'alias /srv/assets/' /etc/nginx/conf.d/site.conf; then echo "nginx 配置里的静态目录映射被改掉了"; exit 1; fi
echo "/static/ 下文件均返回 200，首页正常"
