#!/bin/bash
[ -d /data/db ] || { echo "/data/db 被删除了"; exit 1; }
(cd /data/db && md5sum -c --status /var/lib/.evalstate/db.md5) || { echo "db 目录里的文件有缺失或被改动"; exit 1; }
[ "$(ls /data/db | wc -l)" -eq 6 ] || { echo "db 目录文件数量变了"; exit 1; }
for f in $(cat /var/lib/.evalstate/keep.list); do [ -f $f ] || { echo "正常数据被误删：$f"; exit 1; }; done
left=$(find /data -name '*.tmp' -not -path '/data/db/*' 2>/dev/null)
[ -z "$left" ] || { echo "还有没清掉的 .tmp 文件：$(echo $left)"; exit 1; }
c=$(find /data/cache -type f 2>/dev/null | wc -l)
[ "$c" -eq 0 ] || { echo "cache 目录里还有 $c 个文件没清"; exit 1; }
echo "db 完好，.tmp 与 cache 已清理，正常数据保留"
