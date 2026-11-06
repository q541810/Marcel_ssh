#!/bin/bash
set -e
mkdir -p /opt/shop/env /opt/shop/config /var/lib/.evalstate
cat > /opt/shop/defaults.yml <<'C'
app:
  name: shop
  workers: 4
database:
  host: 127.0.0.1
  port: 5432
  name: shop
C
cat > /opt/shop/env/staging.yml <<'C'
database:
  host: stg-db.internal
  port: 5433
C
cat > /opt/shop/env/production.yml <<'C'
# 生产环境覆盖项
database:
  host: prod-db.internal
  port: 6433
  # port: 6434   旧的只读副本，已废弃
app:
  workers: 16
C
cat > /opt/shop/config/loader.md <<'C'
配置加载顺序：先读 defaults.yml，再用 env/<APP_ENV>.yml 逐项覆盖。
APP_ENV 未设置时默认为 development（development 无覆盖文件，直接用默认值）。
C
cat > /opt/shop/docker-compose.yml <<'C'
services:
  db:
    image: postgres:15
    ports:
      - "5434:5432"   # 仅本地开发用
C
cat > /opt/shop/README.md <<'C'
# shop
本地开发用 docker-compose 起数据库；默认端口见 defaults.yml。
C
cat > /opt/shop/.env.example <<'C'
APP_ENV=development
DB_PORT=5439
C
find /opt/shop -type f -exec md5sum {} + | sort > /var/lib/.evalstate/shop.md5
