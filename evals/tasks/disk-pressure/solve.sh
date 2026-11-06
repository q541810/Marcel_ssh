#!/bin/bash
rm -rf /srv/build-cache/obj
rm -f /srv/logs/access.log.[1-4]
rm -f /srv/backups/db-2026-11-0[1-3].sql.gz
free=$(df -m /srv | awk 'NR==2{print $4}')
echo "已腾出空间，现在 /srv 剩 ${free}M：删了构建缓存、轮转的旧日志，以及按保留策略删了最早的 3 份备份，保留最近 3 份（最新一份没动）。网站和用户上传没碰。"
