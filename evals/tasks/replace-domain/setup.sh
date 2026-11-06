#!/bin/bash
set -e
mkdir -p /etc/myapp/conf.d /var/lib/.evalstate
cat > /etc/myapp/app.conf <<'C'
[server]
host = old.example.com
port = 8443
base_url = https://old.example.com/api
[cors]
allow = https://old.example.com, https://admin.old.example.com
C
cat > /etc/myapp/db.conf <<'C'
[db]
replica = db-replica.old.example.com
primary = db.old.example.com
user = myapp
C
cat > /etc/myapp/conf.d/mail.conf <<'C'
smtp_host = smtp.old.example.com
from = noreply@old.example.com
C
cat > /etc/myapp/conf.d/cdn.conf <<'C'
cdn = https://cdn.old.example.com/assets
fallback = https://old.example.com/static
C
cat > /etc/myapp/legacy.conf <<'C'
# 老系统专用，勿动
legacy_host = old.example.com
legacy_callback = https://old.example.com/cb
C
md5sum /etc/myapp/legacy.conf > /var/lib/.evalstate/legacy.md5
