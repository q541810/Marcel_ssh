#!/bin/bash
cd /srv/app
setsid nohup python3 app.py >/var/log/srvapp.log 2>&1 &
sleep 1.5
