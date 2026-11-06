#!/bin/bash
md5sum -c --status /var/lib/.evalstate/biglog.md5 || { echo "access.log 被改动了（本题只需查询）"; exit 1; }
echo "日志文件未被改动（答案正确性由回复内容判定）"
