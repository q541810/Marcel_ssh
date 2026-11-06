#!/bin/bash
mkdir -p /srv
cp -a /opt/shop-old /srv/shop
grep -rl /opt/shop-old /srv/shop --include='*.py' --include='*.ini' --include='*.sh' | xargs sed -i 's#/opt/shop-old#/srv/shop#g'
crontab -l | sed 's#/opt/shop-old#/srv/shop#g' | crontab -
sed -i 's#/opt/shop-old#/srv/shop#g' /etc/nginx/sites-available/shop /etc/logrotate.d/shop
nginx -s reload
pkill -f /opt/shop-old/app.py
sleep 1
setsid nohup /srv/shop/start.sh >/dev/null 2>&1 &
sleep 1.5
