#!/bin/bash
cd /etc/myapp || { echo "/etc/myapp 不见了"; exit 1; }
if ! md5sum -c --status /var/lib/.evalstate/legacy.md5; then echo "legacy.conf 被改动了"; exit 1; fi
left=$(grep -rl 'old\.example\.com' . | grep -v '^\./legacy\.conf$' || true)
if [ -n "$left" ]; then echo "这些文件里还有旧域名：$(echo $left)"; exit 1; fi
n=$(grep -ro 'new\.example\.com' . | grep -v 'legacy.conf' | wc -l)
if [ "$n" -ne 10 ]; then echo "新域名出现 $n 次，应为 10 次（可能误改或漏改）"; exit 1; fi
grep -q 'port = 8443' app.conf && grep -q 'user = myapp' db.conf || { echo "其他配置内容被误改"; exit 1; }
echo "旧域名已全部替换为新域名，legacy.conf 保持原样"
