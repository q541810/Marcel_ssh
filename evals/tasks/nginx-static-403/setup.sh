#!/bin/bash
set -e
pkill nginx 2>/dev/null || true
rm -f /etc/nginx/sites-enabled/default
mkdir -p /var/www/site /srv/assets/img
echo '<html><body>home MARCEL-HOME</body></html>' > /var/www/site/index.html
echo 'body{color:#333} /* MARCEL-CSS-4410 */' > /srv/assets/app.css
echo 'MARCEL-LOGO-4410' > /srv/assets/img/logo.txt
chown -R root:root /srv/assets
chmod 700 /srv/assets /srv/assets/img
chmod 600 /srv/assets/app.css /srv/assets/img/logo.txt
cat > /etc/nginx/conf.d/site.conf <<'CONF'
server {
    listen 80 default_server;
    server_name _;
    root /var/www/site;
    index index.html;

    location /static/ {
        alias /srv/assets/;
    }
}
CONF
nginx
sleep 1
