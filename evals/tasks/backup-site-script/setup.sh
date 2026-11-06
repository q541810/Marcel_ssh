#!/bin/bash
set -e
mkdir -p /srv/site/css /srv/site/data
echo '<h1>MARCEL-SITE-BACKUP-6620</h1>' > /srv/site/index.html
echo 'body{margin:0}' > /srv/site/css/main.css
echo 'important-data-6620' > /srv/site/data/important.txt
rm -rf /backups
