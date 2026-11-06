#!/bin/bash
sed -i 's#return price \* rate // 100#return round(price * rate / 100, 2)#' /opt/pricing/pricing.py
pkill -f 'python3 server.py'
sleep 1
cd /opt/pricing && setsid nohup python3 server.py >/var/log/pricing.log 2>&1 &
sleep 1.5
