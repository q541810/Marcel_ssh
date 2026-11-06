#!/bin/bash
truncate -s 0 /data/notes/debug.log
sed -i 's/^debug *= *true/debug = false/' /etc/notes/notes.ini
pkill -f /opt/notes/app.py
sleep 1
setsid nohup python3 /opt/notes/app.py >/dev/null 2>&1 &
sleep 1.5
echo "根因不是数据库坏了，而是 /data 磁盘满了（100%）：调试日志 debug.log 把 24M 的盘写满，sqlite 写不进去。已清空 debug.log（服务开着它，直接删不会释放空间）、关掉 debug 并重启服务，60 条旧笔记都在。"
