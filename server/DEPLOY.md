# Marcel SSH 同步服务端部署指南

## 环境要求

- Python 3.10+
- 依赖：`fastapi`、`uvicorn[standard]`、`aiosqlite`、`tomli`（见 `requirements.txt`）
  - `tomli` 用于 Python 3.10 解析 TOML；Python 3.11+ 内置 `tomllib`，无需额外安装

## 依赖安装

```bash
cd server
pip install -r requirements.txt
```

建议用 venv 隔离：

```bash
python -m venv .venv
# Windows
.venv\Scripts\activate
# Linux/macOS
source .venv/bin/activate
pip install -r requirements.txt
```

## 运行模式

服务端有两种模式，通过配置文件 `config.toml` 的 `[server].hosted` 切换：

| 模式 | `[server].hosted` | 适用场景 | 配额 | CORS | 多设备上限 |
| --- | --- | --- | --- | --- | --- |
| 自部署（默认） | `false` / 不设 | 个人、局域网、小团队 | 无限制 | `*`（允许所有来源） | 100 |
| 托管模式 | `true` | 官方托管服务、公开服务 | 200MB/账户 | 需显式配置 | 10 |

## 配置文件 (config.toml)

服务端所有运行参数统一通过 TOML 配置文件管理，**完全废弃环境变量**，环境变量不再有任何作用。

### 配置文件路径

- 默认路径：`./config.toml`（相对当前工作目录）
- 自定义路径：`python main.py --config /path/to/config.toml`
- 首次部署：`cp config.example.toml config.toml` 然后按需修改字段
- 配置文件不存在 → 启动失败，日志提示复制 `config.example.toml` 模板
- 配置文件含敏感信息（admin 密码 hash），生产部署建议 `chmod 600 config.toml`
- `config.toml` 已加入 `.gitignore`，不会进版本库
- `config.example.toml` 是模板，已进版本库

### 完整字段

| 字段（config.toml） | 默认值 | 说明 |
| --- | --- | --- |
| `[server].hosted` | `false` | 是否启用托管模式（多租户 + 配额） |
| `[server].db_path` | `./data/marcel_sync.db` | SQLite 数据库文件路径 |
| `[server].max_devices_per_account` | 自部署 100 / 托管 10 | 每账户最大设备数 |
| `[server].account_quota_bytes` | 托管 209715200（200MB） | 每账户存储配额（字节）；自部署为 0 表示无限制 |
| `[server].cors_origins` | 自部署 `["*"]` / 托管空 | 允许的 CORS 来源，TOML 数组。例：`["https://app.marcel.example", "https://mobile.marcel.example"]` |
| `[websocket].ping_interval` | `20` | WebSocket ping 间隔（秒） |
| `[websocket].ping_timeout` | `60` | WebSocket pong 超时（秒） |
| `[proxy].trusted_ips` | `["127.0.0.1", "::1", "localhost"]` | 可信反代 IP（TOML 数组）；仅白名单内对端才采信 `X-Forwarded-For` / `X-Real-IP`。本机反代保持默认即可 |

### Admin 监控面板（默认关闭）

运维监控大屏，详见 [ADMIN_PANEL.md](./ADMIN_PANEL.md)。默认不启用，启用需配置密码。

| 字段（config.toml） | 默认值 | 说明 |
| --- | --- | --- |
| `[admin].enabled` | `false` | 是否启用 admin 面板。关闭时路由根本不注册，扫描也是 404 |
| `[admin].path` | `/admin_panela` | 面板入口路径。刻意避开 `/admin` 防扫描，可自定义 |
| `[admin].password_hash` | 空 | 密码的 SHA-256 hex（**推荐**）。生成：`python -c "import hashlib; print(hashlib.sha256('密码'.encode()).hexdigest())"` |
| `[admin].password` | 空 | 明文密码（兼容；启动时 hash 入内存，不落库不落日志） |
| `[admin].session_ttl` | `3600` | 会话有效期（秒） |
| `[admin].ip_whitelist` | 空 | 允许访问的 IP/CIDR 白名单（TOML 数组），空=不限。不在白名单内的请求返回 404 |

启用前必须配置 `[admin].password_hash` 或 `[admin].password`，否则启动时会强制关闭并记录错误日志。

## 启动

> 启动前确保已执行 `cp config.example.toml config.toml` 并按需修改字段，否则服务因配置文件缺失无法启动。

### 开发模式（需要热重载）

```bash
cd server
uvicorn main:app --reload --port 8787
```

> 开发模式下 `host`/`port` 由 uvicorn 命令行参数控制，不读 `config.toml`。仅用于本地开发。

### 生产模式（推荐）

```bash
cd server
python main.py
```

`host`/`port`/`workers` 全部从 `config.toml` 的 `[server]` 段读取。自动读取工作目录下的 `./config.toml`。

> **注意**：当前使用单 SQLite 连接 + `asyncio.Lock` 串行化写入，**不支持多 worker**。`[server].workers` 配置 `>1` 会被强制改回 `1` 并记录警告。如需横向扩展，需改用 PostgreSQL 并迁移 `Database` 类。

### 指定自定义配置文件路径

```bash
python main.py --config /etc/marcel-sync/config.toml
```

适用于 systemd / Docker 等把配置文件统一放在 `/etc/` 或挂载路径下的场景。`host`/`port`/`workers` 仍从该配置文件读取。

## systemd 部署（Linux）

1. 创建专用用户和目录：

```bash
sudo useradd -r -s /bin/false -d /var/lib/marcel-sync marcel-sync
sudo mkdir -p /var/lib/marcel-sync/data
sudo mkdir -p /etc/marcel-sync
sudo chown -R marcel-sync:marcel-sync /var/lib/marcel-sync
```

2. 部署代码：

```bash
sudo mkdir -p /opt/marcel-sync
sudo cp -r server/* /opt/marcel-sync/
sudo chown -R marcel-sync:marcel-sync /opt/marcel-sync
cd /opt/marcel-sync
sudo -u marcel-sync python -m venv .venv
sudo -u marcel-sync .venv/bin/pip install -r requirements.txt
```

3. 部署配置文件：

```bash
sudo cp /opt/marcel-sync/config.example.toml /etc/marcel-sync/config.toml
sudo chown marcel-sync:marcel-sync /etc/marcel-sync/config.toml
sudo chmod 600 /etc/marcel-sync/config.toml
# 按需修改字段：[server].db_path、[server].hosted、[admin] 等
sudo -u marcel-sync nano /etc/marcel-sync/config.toml
```

配置文件示例（自部署，启用 admin 面板）：

```toml
[server]
hosted = false
db_path = "/var/lib/marcel-sync/data/marcel_sync.db"

[admin]
enabled = true
path = "/admin_panela"
password_hash = "你的 SHA-256 hex"
```

4. 创建 systemd unit `/etc/systemd/system/marcel-sync.service`。

方式一：把配置文件放在工作目录下（默认路径 `./config.toml`），通过 `WorkingDirectory` 指定：

```ini
[Unit]
Description=Marcel SSH Sync Server
After=network.target

[Service]
Type=simple
User=marcel-sync
Group=marcel-sync
WorkingDirectory=/opt/marcel-sync
ExecStart=/opt/marcel-sync/.venv/bin/python /opt/marcel-sync/main.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

此时需把 `config.toml` 放在 `/opt/marcel-sync/config.toml`，`host`/`port`/`workers` 从该文件的 `[server]` 段读取。

方式二：把配置文件统一放在 `/etc/`，通过 `--config` 显式指定路径：

```ini
[Unit]
Description=Marcel SSH Sync Server
After=network.target

[Service]
Type=simple
User=marcel-sync
Group=marcel-sync
WorkingDirectory=/opt/marcel-sync
ExecStart=/opt/marcel-sync/.venv/bin/python /opt/marcel-sync/main.py --config /etc/marcel-sync/config.toml
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

两种方式任选其一，**不要**再使用 `Environment=` 行设置参数（环境变量已完全废弃），也**不要**在命令行加 `--host`/`--port`/`--workers`（这些参数已移除，统一由配置文件控制）。

5. 启动并设置开机自启：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now marcel-sync
sudo systemctl status marcel-sync
```

6. 查看日志：

```bash
sudo journalctl -u marcel-sync -f
```

## Nginx 反向代理（TLS 终结）

本机 `proxy_pass http://127.0.0.1:8787` 时，TCP 对端为 127.0.0.1，落在默认 `[proxy].trusted_ips` 内，限流会使用 `X-Real-IP`（应为真实客户端）。反代不在本机时，必须把反代 IP 写入 `config.toml` 的 `[proxy].trusted_ips` 数组。

```nginx
server {
    listen 443 ssl http2;
    server_name sync.marcel.example;

    ssl_certificate     /etc/letsencrypt/live/sync.marcel.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sync.marcel.example/privkey.pem;

    # HTTP API
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket
    location /ws {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket 长连接超时（默认 60s 太短）
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

**关键点**：
- `/ws` 必须单独配置 `Upgrade` / `Connection` header
- `proxy_read_timeout` 默认 60 秒，WebSocket 空闲会被断开，建议设为 300 秒以上

## 数据目录

- SQLite 数据库文件默认在 `./data/marcel_sync.db`（可用 `[server].db_path` 修改）
- 启动时自动创建 `data/` 目录和数据库 schema（幂等）
- 启用 WAL 模式提升并发读写性能
- 启用外键约束，级联删除：删账户会级联删除 devices 和 sync_snapshots

## 备份

只需备份 SQLite 文件即可：

```bash
# 在线备份（不停服）
sqlite3 /var/lib/marcel-sync/data/marcel_sync.db ".backup /backup/marcel_sync_$(date +%Y%m%d).db"
```

## 升级

1. 停止服务：`sudo systemctl stop marcel-sync`
2. 更新代码：`sudo cp -r server/* /opt/marcel-sync/`
3. 更新依赖（如有变更）：`sudo -u marcel-sync /opt/marcel-sync/.venv/bin/pip install -r /opt/marcel-sync/requirements.txt`
4. 启动服务：`sudo systemctl start marcel-sync`
5. schema 增量迁移会在启动时自动执行（`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN`）

## 健康检查

```bash
curl http://127.0.0.1:8787/health
```

返回：

```json
{"status": "ok", "mode": "self-hosted"}
```

## 端口

默认 8787。在 `config.toml` 的 `[server].port` 修改：

```toml
[server]
host = "0.0.0.0"
port = 9090
```

## Docker 部署

可选，服务端没有官方 Docker 镜像，自行构建：

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
# config.example.toml 已随 COPY . . 进入镜像，作为模板
VOLUME /data
EXPOSE 8787
CMD ["python", "main.py"]
```

构建并运行（必须挂载 `config.toml`，否则容器内无配置文件导致启动失败）：

```bash
docker build -t marcel-sync ./server

# 先在宿主机准备配置文件
cp server/config.example.toml ./config.toml
# 按需修改 config.toml 字段

docker run -d --name marcel-sync \
  -p 8787:8787 \
  -v marcel-sync-data:/data \
  -v /path/to/your/config.toml:/app/config.toml:ro \
  --restart unless-stopped \
  marcel-sync
```

挂载说明：
- `-v marcel-sync-data:/data`：持久化 SQLite 数据库（与 `[server].db_path` 配合，把 `db_path` 设为 `/data/marcel_sync.db`）
- `-v /path/to/your/config.toml:/app/config.toml:ro`：只读挂载配置文件，覆盖镜像内的模板
- `-p 8787:8787`：宿主机端口:容器端口。若 `config.toml` 的 `[server].port` 改为非 8787，`-p` 的容器端口需对应修改（如 `-p 9090:9090`）
- **不要**再用 `-e HOSTED_MODE=...` 等环境变量（已完全废弃）

## 客户端连接

在 Marcel SSH 设置 → 同步 → 服务器 URL 中填入：

- 自部署 HTTP：`http://your-server:8787`
- 自部署 HTTPS（推荐）：`https://sync.marcel.example`
- 局域网：`http://192.168.1.100:8787`

## 故障排查

- **CORS 报错**：自部署模式 `[server].cors_origins` 默认 `["*"]`，无需配置。托管模式必须显式设置。
- **配置文件不存在**：复制模板 `cp config.example.toml config.toml`，然后修改字段。若用 `--config` 指定了自定义路径，确认路径与权限正确。
- **admin 启用后日志报已强制关闭**：`[admin].enabled = true` 但未配置 `password_hash` 或 `password`，启动时会记录错误并禁用 admin 面板。补上其中任一字段后重启。
- **WebSocket 连不上**：检查 Nginx 是否配置了 `/ws` 的 Upgrade header。
- **403/401**：API Key 过期或设备被删除。客户端需重新配对。
- **数据库锁定**：SQLite 单连接 + asyncio.Lock 已串行化，不应出现。如出现，检查是否启用了多 worker（不支持）。
- **磁盘满**：SQLite 数据库会无限增长（自部署无配额），定期清理或改用托管模式。
- **反代后限流失效 / 显示 IP 为反代 IP**：非本机反代时必须把反代 IP 加入 `config.toml` 的 `[proxy].trusted_ips`。
