#!/bin/bash
cur=$(find /opt/shop -type f -exec md5sum {} + | sort)
[ "$cur" = "$(cat /var/lib/.evalstate/shop.md5)" ] || { echo "/opt/shop 下的文件被改动了（本题只需查询）"; exit 1; }
echo "配置文件未被改动（答案正确性由回复内容判定）"
