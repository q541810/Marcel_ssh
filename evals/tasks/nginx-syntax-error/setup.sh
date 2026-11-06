#!/bin/bash
set -e
pkill nginx 2>/dev/null || true
rm -f /etc/nginx/sites-enabled/default
mkdir -p /var/www/site
echo '<html><body><h1>MARCEL-SITE-OK-7731</h1></body></html>' > /var/www/site/index.html
cat > /etc/nginx/conf.d/site.conf <<'CONF'
server {
    listen 80 default_server;
    server_name _;
    root /var/www/site
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }
}
CONF
