#!/bin/bash
getp() { grep -E '^port' "$1" | head -1 | sed 's/.*=//; s/[[:space:]]//g'; }
api=$(getp /opt/svc-api/config.ini)
adm=$(getp /opt/svc-admin/config.ini)
[ "$adm" = "8082" ] || { echo "admin 的端口被改了（现在是 ${adm:-空}），应保持 8082"; exit 1; }
[ "$api" = "9090" ] || { echo "api 的端口还不是 9090（现在是 ${api:-空}）"; exit 1; }
grep -q 'name = svc-api' /opt/svc-api/config.ini && grep -q 'level = info' /opt/svc-api/config.ini && grep -q 'host = 0.0.0.0' /opt/svc-api/config.ini || { echo "api 配置的其他内容被破坏"; exit 1; }
echo "api 端口已改为 9090，admin 保持 8082"
