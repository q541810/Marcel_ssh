#!/bin/bash
set -e
L=/var/log/myapp
S=/var/lib/.evalstate
mkdir -p $L/audit $S
mk() { head -c "$2" /dev/urandom > "$1"; touch -d "$3" "$1"; }
mk $L/app.log.1      20000000 "1 day ago"
mk $L/app.log.2.gz   10000000 "3 days ago"
mk $L/app.log.3      25000000 "9 days ago"
mk $L/app.log.4.gz   15000000 "12 days ago"
mk $L/app.log.5.gz   15000000 "20 days ago"
mk $L/app.log.6.gz   15000000 "35 days ago"
mk $L/app.log.7.gz   15000000 "60 days ago"
mk $L/audit/audit.log.1      10000000 "40 days ago"
mk $L/audit/audit-old.log.gz 10000000 "90 days ago"
head -c 3000000 /dev/urandom | base64 > $L/app.log
ls $L/app.log.3 $L/app.log.4.gz $L/app.log.5.gz $L/app.log.6.gz $L/app.log.7.gz > $S/old.list
ls $L/app.log.1 $L/app.log.2.gz > $S/recent.list
(cd $L/audit && md5sum audit.log.1 audit-old.log.gz) > $S/audit.md5
stat -c %s $L/app.log > $S/applog.size
# 模拟正在写入的 app.log
setsid nohup bash -c 'exec >> /var/log/myapp/app.log; while true; do echo "$(date +%T) heartbeat"; sleep 2; done' >/dev/null 2>&1 &
