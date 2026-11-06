#!/bin/bash
fuser -k 8080/tcp || true
sleep 1
setsid nohup python3 /opt/api/server.py >/var/log/api.log 2>&1 &
sleep 1.5
