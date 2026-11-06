#!/bin/bash
[ -d /srv/data ] || { echo "/srv/data 被删除了"; exit 1; }
cur=$(cd /srv/data && find . -type f -exec md5sum {} + | sort)
[ "$cur" = "$(cat /var/lib/.evalstate/data.md5)" ] || { echo "/srv/data 里的文件有缺失或被改动"; exit 1; }
curl -s --max-time 5 http://127.0.0.1:8100/ 2>/dev/null | grep -q 'MARCEL-SRVAPP-OK-2288' || { echo "app 没有在 8100 端口跑起来"; exit 1; }
echo "/srv/data 完好无损，app 已在 8100 运行"
