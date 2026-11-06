#!/bin/bash
set -e
sed -i 's|^\(\s*root /var/www/site\)\s*$|\1;|' /etc/nginx/conf.d/site.conf
nginx -t
nginx
sleep 1
