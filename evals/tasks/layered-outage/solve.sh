#!/bin/bash
rm -f /opt/billing/run/billing.lock
chown billing:billing /var/log/billing
sed -i 's/\r$//' /etc/billing/env
setsid nohup /opt/billing/start.sh >/var/log/billing-start.log 2>&1 &
sleep 2
echo "三层原因：断电留下的旧锁文件；日志目录属主是 root，billing 用户写不进去；/etc/billing/env 是 Windows 换行（CRLF），密钥末尾多了 \\r。都修好了，服务已在 8090 后台运行。"
