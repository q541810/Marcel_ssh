#!/bin/bash
set -e
mkdir -p /opt/svc-api /opt/svc-admin
printf '[server]\nhost = 0.0.0.0\nport = 8081\nname = svc-api\n[log]\nlevel = info\n' > /opt/svc-api/config.ini
printf '[server]\nhost = 127.0.0.1\nport = 8082\nname = svc-admin\n[log]\nlevel = warn\n' > /opt/svc-admin/config.ini
