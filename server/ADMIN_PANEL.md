# Admin 监控面板

Marcel SSH 同步服务端的运维监控大屏。**默认关闭**，需显式启用。

---

## 功能概览

- **总览指标**：DAU（日活账户）、MAU（月活账户）、当前在线连接数、在线账户数、总账户数、总设备数、数据库大小、配额使用
- **系统资源**：CPU、内存、磁盘占用率（psutil 采集）
- **账户列表**：每个账户的配额占用、设备数、最后活跃时间、在线状态
- **设备下钻**：展开账户可查看其下设备（ID 截断、平台、在线状态、最后活跃时间）

**不展示任何同步数据内容**：E2E 加密的数据（`encrypted_value`、`encrypted_sync_key`、`sync_profile`）均不返回，仅返回配额字节数和元信息。

---

## 启用步骤

### 1. 生成密码 hash（推荐）

```bash
python -c "import hashlib; print(hashlib.sha256('你的密码'.encode()).hexdigest())"
```

将输出的 64 位 hex 字符串填入 config.toml 的 `[admin].password_hash`。

### 2. 编辑 config.toml

复制模板：`cp config.example.toml config.toml`，然后在 `[admin]` 段配置：

```toml
[admin]
enabled = true
password_hash = "<上一步生成的 hash>"
# 可选：
path = "/your_secret_path"
session_ttl = 1800
ip_whitelist = ["127.0.0.1", "::1", "192.168.1.0/24"]
```

- `path` 默认 `/admin_panela`（刻意避开 `/admin` 防扫）
- `session_ttl` 单位为秒，默认 3600 = 1 小时
- `ip_whitelist` 为 IP/CIDR 数组，留空 `[]` 表示不限

### 3. 安装依赖

```bash
pip install -r requirements.txt
```

`psutil` 已写入 `requirements.txt`，仅启用面板时需要；缺失时面板仍可运行，系统资源数据降级为 0。

### 4. 启动服务端

```bash
python main.py
```

`host`/`port`/`workers` 从 `config.toml` 的 `[server]` 段读取。

启动日志会显示面板状态：

```
Admin 监控面板已启用: 入口 /admin_panela（IP 白名单: 已配置 3 条）
```

或：

```
Admin 监控面板未启用（[admin].enabled=false）
```

### 5. 访问面板

浏览器打开 `https://your-server/admin_panela`（路径取决于 `[admin].path`），输入密码登录。

---

## 配置项一览

| config.toml 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `[admin].enabled` | `false` | 是否启用 admin 面板。关闭时路由根本不注册，扫描也是 404 |
| `[admin].path` | `/admin_panela` | 面板入口路径。刻意避开 `/admin` 防扫描，可自定义 |
| `[admin].password_hash` | 空 | 密码的 SHA-256 hex（**推荐**） |
| `[admin].password` | 空 | 明文密码（兼容；启动时 hash 入内存，不落库不落日志） |
| `[admin].session_ttl` | `3600` | 会话有效期（秒） |
| `[admin].ip_whitelist` | `[]` | 允许访问的 IP/CIDR 白名单（数组），空=不限 |

### 配置校验规则

- `[admin].enabled=true` 但未配置密码（hash 或明文都未设）→ **强制关闭**，记录错误日志，不阻断主服务启动
- `[admin].path` 校验：
  - 必须以 `/` 开头（自动补）
  - 仅允许 `[A-Za-z0-9_/-]`
  - 不得包含 `..` 或 `//`
  - 不得与保留路径冲突：`/`、`/health`、`/ws`、`/api`、`/openapi`、`/docs`、`/redoc`
  - 校验失败回退默认 `/admin_panela`，不阻断主服务
- 密码优先级：`[admin].password_hash` > `[admin].password`

### 明文密码 vs Hash

| 方式 | 优点 | 缺点 |
| --- | --- | --- |
| `[admin].password_hash`（推荐） | 配置文件里不是明文，进程内存里也只有 hash | 需预先用命令生成 |
| `[admin].password`（兼容） | 配置简单 | 启动日志会 warning；进程内存短暂存在明文（hash 后丢弃） |

两者都不会把明文密码写入数据库或日志文件。

---

## 数据口径

| 指标 | 定义 | 数据源 |
| --- | --- | --- |
| **DAU** | 今天（UTC）调过 API 的**账户**去重数 | `SELECT COUNT(DISTINCT account_id) FROM devices WHERE last_seen_at >= datetime('now', 'start of day')` |
| **MAU** | 最近 30 天调过 API 的**账户**去重数 | `SELECT COUNT(DISTINCT account_id) FROM devices WHERE last_seen_at >= datetime('now', '-30 days')` |
| **当前在线** | 当前 WebSocket 连接数 | `ws_manager.total_connections()` |
| **在线账户数** | 当前有在线连接的账户数 | `len(ws_manager._connections)` |
| **配额使用** | 该账户所有 `sync_snapshots.encrypted_value` 字节总和 | `SUM(LENGTH(encrypted_value))` |

**说明**：

- DAU/MAU 基于 `devices.last_seen_at`，该字段在 `verify_api_key`（每次认证）时刷新，覆盖所有需要认证的端点（push/pull/snapshot/devices 等）
- DAU/MAU 按**账户**去重而非按设备，符合用户语义
- 在线数基于 WebSocket 连接池，不含 HTTP 短连接

---

## 安全设计

共 14 项安全措施，全部在 `admin_panel.py` 实现：

### 1. 默认关闭 + 路由不注册

`[admin].enabled=false`（默认）时，`main.py` 根本不调用 `create_admin_router`，路由不存在。扫描 `/admin_panela` 返回 404，与不存在的路径无差别。

### 2. 路径混淆

默认入口 `/admin_panela`（不是 `/admin`），可在 `[admin].path` 自定义。防扫描器命中常见 admin 路径。

### 3. 密码 hash 存储

密码以 SHA-256 hash 形式存在 config.toml，进程内存里也只有 hash。明文密码仅在启动时 hash 入内存后丢弃。

### 4. 常量时间密码比对

用 `hmac.compare_digest` 比对 hash，防时序攻击。

### 5. 高熵 session token

`secrets.token_urlsafe(32)` 生成 256 位熵的 session token，内存存储，TTL 由 `[admin].session_ttl` 控制。

### 6. 登录速率限制

登录端点独立速率限制 5 次/分钟/IP（复用 `rate_limit.SlidingWindow`），防暴力破解。

### 7. IP 白名单（可选）

`[admin].ip_whitelist` 配置 IP/CIDR 白名单。不在白名单内的请求**返回 404 而非 401**，不暴露面板存在。空白名单表示不限。

### 8. 敏感数据截断

- `account_id` / `device_id` 截断显示（前 8 位 + `…`）
- 不返回 `api_key_hash` / `encrypted_sync_key` / `encrypted_value` / `sync_profile` 内容
- 设备查询接口接受截断 ID（前 8 位），后端用前缀匹配找完整 ID

### 9. 同源访问

admin 路由**不走全局 CORS 中间件**（不返回 `Access-Control-Allow-Origin`），强制同源访问。

### 10. 严格 CSP + nonce

每个请求生成新 nonce（`secrets.token_urlsafe(16)`），替换 HTML 模板里的 `{{NONCE}}` 占位符。CSP 策略：

```
default-src 'none';
script-src 'nonce-{nonce}';
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src 'self' https://fonts.gstatic.com;
img-src 'self' data:;
connect-src 'self';
base-uri 'none';
form-action 'self';
frame-ancestors 'none'
```

附加安全 header：

- `X-Frame-Options: DENY`（防点击劫持）
- `X-Content-Type-Options: nosniff`（防 MIME 嗅探）
- `Referrer-Policy: no-referrer`（防 Referer 泄露）

### 11. 审计日志

登录成功/失败、登出写入主 logger。**密码、提供的 hash 不落日志**。日志示例：

```
[INFO] admin_panel: admin 登录成功: IP=127.0.0.1
[WARNING] admin_panel: admin 登录失败: IP=1.2.3.4 UA=Mozilla/5.0...
[INFO] admin_panel: admin 登出: IP=127.0.0.1
[WARNING] admin_panel: admin 登录限流触发: IP=1.2.3.4
```

### 12. SQL 参数化 + 路径校验

所有 SQL 查询用参数化（`?` 占位符），防 SQL 注入。`[admin].path` 在 `config.py` 层做正则校验 + 保留路径冲突检查 + `..`/`//` 检查，防路径遍历。

### 13. session 重启即失效

session 纯内存存储，进程重启即失效（需重新登录）。过期 session 在每次 `create`/`verify` 时自动清理，防内存泄漏。

### 14. 登录失败不区分路径

路径不存在（IP 不在白名单）直接返回 404；密码错误返回 401。攻击者无法通过响应码区分"面板不存在"和"密码错误"。

---

## API 接口

所有接口前缀为 `[admin].path`（如 `/admin_panela`），除登录外均需 `Authorization: Bearer <token>` header。

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| GET | `/` | 无（IP 白名单） | 返回 HTML 页面（含 nonce） |
| POST | `/api/login` | 无（IP 白名单 + 限流） | 密码登录，返回 token |
| POST | `/api/logout` | Bearer token | 注销当前 session |
| GET | `/api/overview` | Bearer token | 总览指标 |
| GET | `/api/system` | Bearer token | 系统资源（CPU/内存/磁盘） |
| GET | `/api/accounts` | Bearer token | 账户列表（含配额、设备数、在线状态） |
| GET | `/api/accounts/{account_id}/devices` | Bearer token | 指定账户下设备列表 |

`account_id` 接受截断 ID（前 8 位 hex）。

---

## 限制与注意事项

### 单进程限制

- session 内存存储，**不支持多 worker**（当前服务端整体也不支持，SQLite 单连接）
- 速率限制计数器也是内存的，多 worker 下每个 worker 独立计数（足够防单点滥用，但不精确）
- 如未来迁移到多 worker + PostgreSQL，需把 session 改为 Redis/DB 存储

### 重启行为

- 进程重启后所有 session 失效，需重新登录
- 进程重启后 `_server_started_at` 重置，uptime 从 0 开始计
- DAU/MAU 基于 DB 持久化的 `last_seen_at`，重启不影响历史数据

### psutil 缺失降级

`psutil` 未安装时面板仍可运行，系统资源数据（CPU/内存/磁盘）降级为 0，日志会 warning：

```
psutil 未安装，系统资源数据将不可用
```

### HTTPS 强烈推荐

面板登录走密码 + session token，非 HTTPS 下密码可能被中间人嗅探。前端会检测协议，非 HTTPS（且非 localhost）时显示警告条幅。

**生产环境务必通过 HTTPS 访问**，或用 `[admin].ip_whitelist` 限制在内网/本地。

### 配额计算口径

- 配额 = `SUM(LENGTH(encrypted_value))`，单位字节
- 自部署模式（`[server].hosted=false`）配额为 0（无限制），面板显示"配额无限制"
- 托管模式（`[server].hosted=true`）配额为 `[server].account_quota_bytes`（默认 200MB）
- 删除账户会级联删除其 `devices` 和 `sync_snapshots`，配额自动释放

### 日志不记录敏感信息

- 密码、提供的 hash 不落日志
- account_id / device_id 在日志里截断为前 8 位 + `…`（与 `main.py` 其他端点一致）

---

## 部署示例

### systemd（推荐生产部署）

在 `/etc/marcel-sync/config.toml` 的 `[admin]` 段配置（systemd unit 文件无需任何 `Environment` 行）：

```toml
[admin]
enabled = true
password_hash = "your_sha256_hash_here"
path = "/your_secret_path"
session_ttl = 3600
ip_whitelist = ["127.0.0.1", "::1", "10.0.0.0/8"]
```

重启服务生效：

```bash
sudo systemctl restart marcel-sync
```

### Docker

将宿主机配置文件挂载进容器，在 config.toml 的 `[admin]` 段配置：

```bash
docker run -d --name marcel-sync \
  -p 8787:8787 \
  -v marcel-sync-data:/data \
  -v /path/to/config.toml:/app/config.toml:ro \
  --restart unless-stopped \
  marcel-sync
```

容器内 `/app/config.toml` 的 `[admin]` 段示例：

```toml
[admin]
enabled = true
password_hash = "your_sha256_hash_here"
ip_whitelist = ["127.0.0.1", "::1"]
```

### Nginx 反代（HTTPS 终结）

admin 面板走主路由，无需特殊 Nginx 配置。已有的 `location /` 配置即可覆盖：

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

若启用了 `[admin].ip_whitelist`，需确保 Nginx 在 `[proxy].trusted_ips`（默认含 127.0.0.1）内，这样 admin 才能拿到真实客户端 IP 做白名单判断。

---

## 故障排查

### 配置文件不存在

启动失败并提示：

```
配置文件不存在: ./config.toml
请复制模板：cp config.example.toml config.toml
或指定路径：python main.py --config /path/to/config.toml
```

复制模板 `cp config.example.toml config.toml`，按需修改 `[admin]` 段后重启。自定义路径用 `python main.py --config /etc/marcel-sync/config.toml`。

### 访问 /admin_panela 返回 404

- 检查 `[admin].enabled` 是否为 `true`
- 检查启动日志是否有"Admin 监控面板已启用"
- 检查 `[admin].path` 是否被自定义成了其他路径
- 检查 `[admin].ip_whitelist` 是否把你的 IP 排除在外（白名单内的 IP 才能访问，其他返回 404）

### 启用后日志报"已强制关闭"

```
admin.enabled=true 但未配置密码（admin.password_hash 或 admin.password），admin 面板已强制关闭
```

> 配置 `[admin].password_hash` 或 `[admin].password` 后重启。

### 登录提示"尝试过于频繁"

> 触发了登录速率限制（5 次/分钟/IP），等 60 秒后重试。

### 系统资源都显示 0

> `psutil` 未安装。`pip install psutil` 后重启。

### 会话频繁过期

> 调大 `[admin].session_ttl`（单位秒，默认 3600 = 1 小时）。

### 修改密码后旧 session 还能用

> session 是内存的，改密码不会让已签发的 session 失效。需重启服务端清空内存 session，或等 TTL 自然过期。
