#!/bin/bash
lines=$( { crontab -l 2>/dev/null; cat /etc/crontab /etc/cron.d/* 2>/dev/null; } | grep -v '^[[:space:]]*#' | grep '/opt/backup/backup.sh' || true)
[ -n "$lines" ] || { echo "没找到执行 backup.sh 的定时任务"; exit 1; }
echo "$lines" | grep -Eq '^[[:space:]]*0[[:space:]]+3[[:space:]]+\*[[:space:]]+\*[[:space:]]+\*[[:space:]]' || { echo "定时任务的时间不是每天 3:00"; exit 1; }
if [ ! -x /opt/backup/backup.sh ]; then
  echo "$lines" | grep -Eq '(bash|sh)[[:space:]]+/opt/backup/backup.sh' || { echo "backup.sh 不可执行，且定时任务没用 bash 调用，到点会失败"; exit 1; }
fi
f=$(ls /var/backups/notes-*.tar.gz 2>/dev/null | head -1)
[ -n "$f" ] || { echo "/var/backups 下没有备份产物，说明没手动跑过"; exit 1; }
tar tzf "$f" 2>/dev/null | grep -q 'notes/a.txt' || { echo "备份归档损坏或内容不对"; exit 1; }
echo "每天 3:00 的定时任务已配置，手动备份产物存在且有效"
