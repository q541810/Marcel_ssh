"""Admin 监控面板（默认关闭，需在 config 显式启用）。

安全设计（必须完整保留，改动需 review）：
1. 默认关闭，关闭时路由根本不注册（main.py 控制），扫到也是 404
2. 路径混淆（默认 /admin_panela，可在 [admin].path 自定义）
3. 密码 SHA-256 hash 存储；明文密码仅在启动时 hash 入内存，不落库不落日志
4. 登录比对用 hmac.compare_digest（常量时间，防时序攻击）
5. Session token = secrets.token_urlsafe(32)（256 位熵），内存存储，TTL 由 [admin].session_ttl 控制
6. 登录端点独立速率限制 5/min/IP（复用 rate_limit.SlidingWindow）
7. IP 白名单（可选 [admin].ip_whitelist），不在白名单内返回 404（不暴露面板存在）
8. 不暴露敏感数据：
   - account_id / device_id 截断显示（前 8 位 + …）
   - 不返回 api_key_hash / encrypted_sync_key / encrypted_value / sync_profile 内容
9. 同源访问：admin 路由不走全局 CORS（不返回 Access-Control-Allow-Origin）
10. CSP + nonce：每个 <script> 带 nonce，CSP header 限制 script-src 'nonce-{nonce}'
    - default-src 'none'；style-src 允许内嵌 + Google Fonts；font-src 允许 Google Fonts
    - X-Frame-Options: DENY；X-Content-Type-Options: nosniff；Referrer-Policy: no-referrer
11. 审计日志：登录成功/失败、登出（写入主 logger，密码不落日志）
12. 参数化查询防 SQL 注入；路径校验防遍历（config 层已做）
13. session 重启即失效（纯内存）；过期 session 访问时自动清理
14. 登录失败统一 401（不区分"路径不存在"和"密码错误"——路径不存在直接 404）

数据口径：
- DAU = 今天（UTC）调过 API 的 account_id 去重数（基于 devices.last_seen_at）
- MAU = 最近 30 天调过 API 的 account_id 去重数
- 当前在线 = ws_manager.total_connections()
- 配额 = SUM(LENGTH(encrypted_value))，单位字节
"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import logging
import os
import secrets
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, Field
from rate_limit import SlidingWindow, get_client_ip

logger = logging.getLogger("admin_panel")

# ── 常量 ──────────────────────────────────────────────

# 登录端点速率限制：5 次/分钟/IP（per-IP，防单 IP 暴力破解）
_LOGIN_MAX = 5
_LOGIN_WINDOW_SEC = 60
_login_windows: dict[str, SlidingWindow] = {}
_login_windows_lock = threading.Lock()
# 防内存泄漏：字典超此阈值时清理过期条目
_LOGIN_WINDOWS_MAX = 1024


def _check_login_rate(ip: str) -> bool:
    """per-IP 登录速率检查。返回 True 表示允许。"""
    with _login_windows_lock:
        win = _login_windows.get(ip)
        if win is None:
            win = SlidingWindow(max_requests=_LOGIN_MAX, window_seconds=_LOGIN_WINDOW_SEC)
            _login_windows[ip] = win
            # 粗粒度清理：字典过大时清空过期窗口（SlidingWindow.timestamps 为空即过期）
            if len(_login_windows) > _LOGIN_WINDOWS_MAX:
                stale = [k for k, w in _login_windows.items() if not w.timestamps]
                for k in stale:
                    _login_windows.pop(k, None)
        return win.allow()

# nonce 占位符（HTML 模板里每个 <script> 都带 nonce="{{NONCE}}"）
_NONCE_PLACEHOLDER = "{{NONCE}}"

# 截断显示的前缀长度
_ID_PREFIX_LEN = 8


# ── Session 管理 ──────────────────────────────────────

@dataclass
class _Session:
    token: str
    expires_at: float  # unix timestamp
    ip: str
    created_at: float


class SessionStore:
    """内存 session 存储，单进程（当前服务端不支持多 worker）。

    线程安全：所有操作在 asyncio 事件循环里。SlidingWindow 内部自带 threading.Lock。
    """

    def __init__(self) -> None:
        self._sessions: dict[str, _Session] = {}

    def create(self, ip: str, ttl: int) -> tuple[str, int]:
        """创建 session，返回 (token, expires_in_seconds)。"""
        self._cleanup()
        token = secrets.token_urlsafe(32)  # 256 位熵
        now = time.time()
        self._sessions[token] = _Session(
            token=token,
            expires_at=now + ttl,
            ip=ip,
            created_at=now,
        )
        return token, ttl

    def verify(self, token: str) -> bool:
        """校验 token，过期则清除。"""
        self._cleanup()
        s = self._sessions.get(token)
        if s is None:
            return False
        if time.time() >= s.expires_at:
            self._sessions.pop(token, None)
            return False
        return True

    def revoke(self, token: str) -> None:
        self._sessions.pop(token, None)

    def _cleanup(self) -> None:
        """清理过期 session。每次创建/校验时调用，避免内存泄漏。"""
        now = time.time()
        expired = [t for t, s in self._sessions.items() if now >= s.expires_at]
        for t in expired:
            self._sessions.pop(t, None)

    def count(self) -> int:
        return len(self._sessions)


_sessions = SessionStore()


# ── IP 白名单 ─────────────────────────────────────────

def _ip_allowed(client_ip: str, whitelist: list[str]) -> bool:
    """检查 client IP 是否在白名单内。空白名单表示不限。"""
    if not whitelist:
        return True
    try:
        ip = ipaddress.ip_address(client_ip)
    except ValueError:
        return False
    for entry in whitelist:
        try:
            if ip in ipaddress.ip_network(entry, strict=False):
                return True
        except ValueError:
            continue
    return False


# ── 数据截断工具 ──────────────────────────────────────

def _short_id(full: str) -> str:
    """截断 ID 为前 8 位 + …，避免泄露完整 hash。"""
    if not full:
        return ""
    if len(full) <= _ID_PREFIX_LEN:
        return full
    return full[:_ID_PREFIX_LEN] + "…"


# ── 请求模型 ──────────────────────────────────────────

class LoginRequest(BaseModel):
    password: str = Field(..., min_length=1, max_length=1024, description="admin 密码")


# ── 响应模型 ──────────────────────────────────────────

class LoginResponse(BaseModel):
    token: str
    expires_in: int


class OverviewResponse(BaseModel):
    dau: int = Field(..., description="日活（今天调过 API 的账户去重数，UTC）")
    mau: int = Field(..., description="月活（最近 30 天调过 API 的账户去重数）")
    online_connections: int = Field(..., description="当前在线 WebSocket 连接数")
    online_accounts: int = Field(..., description="当前有在线连接的账户数")
    total_accounts: int
    total_devices: int
    quota_used_bytes: int = Field(..., description="全服务端已用配额（字节）")
    quota_limit_bytes: int = Field(..., description="每账户配额上限（字节）；0=无限制")
    server_uptime_seconds: int
    db_size_bytes: int


class SystemResponse(BaseModel):
    cpu_percent: float
    mem_percent: float
    mem_used_bytes: int
    mem_total_bytes: int
    disk_percent: float
    disk_used_bytes: int
    disk_total_bytes: int
    db_size_bytes: int
    server_uptime_seconds: int


class AccountItem(BaseModel):
    account_id: str = Field(..., description="账户完整 ID（SHA-256 hex，用于设备列表查询）")
    account_id_short: str = Field(..., description="账户 ID 截断（前 8 位 + …）")
    device_count: int
    quota_used_bytes: int
    quota_limit_bytes: int
    last_active_at: str | None = Field(None, description="该账户最近一次 API 活跃时间（UTC ISO）")
    created_at: str
    online: bool = Field(..., description="该账户当前是否有在线连接")


class DeviceItem(BaseModel):
    device_id_short: str
    platform: str
    last_seen_at: str
    online: bool


class AccountListResponse(BaseModel):
    accounts: list[AccountItem]
    quota_limit_bytes: int


class DeviceListResponse(BaseModel):
    account_id_short: str
    devices: list[DeviceItem]


# ── 依赖：认证 + IP 白名单 ────────────────────────────

async def _require_admin(
    request: Request,
    authorization: str = Header(default=""),
) -> None:
    """验证 admin session token。失败返回 401。"""
    # IP 白名单检查
    client_ip = get_client_ip(request)
    if not _ip_allowed(client_ip, _admin_ip_whitelist):
        # 不暴露面板存在，返回 404
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)

    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="未认证")
    token = authorization[7:]
    if not _sessions.verify(token):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="会话已过期或无效")


# ── 模块级依赖（create_admin_router 时注入） ──────────
# 用模块级变量避免闭包嵌套，Depends(_require_admin) 需要访问 config
_admin_password_hash: str = ""
_admin_ip_whitelist: list[str] = []
_admin_session_ttl: int = 3600
_admin_path: str = "/admin_panela"

# 外部依赖（main.py 注入）
_db = None  # Database
_ws_manager = None  # ConnectionManager
_sync_engine = None  # SyncEngine
_quota_bytes: int = 0
_db_path: str = "./data/marcel_sync.db"
_server_started_at: float = time.time()
_html_template: str = ""  # 启动时读取的 HTML 模板（含 {{NONCE}} 占位符）

# psutil 预热标志（首次 cpu_percent 调用返回 0，需预热）
_psutil_ready: bool = False


def _ensure_psutil_ready() -> None:
    """首次调用 cpu_percent 前需要预热，否则返回 0。

    psutil 未安装时也标记为已检查，避免每次调用都重复 import 尝试（性能 + 日志刷屏）。
    _collect_system 的 try/except ImportError 会处理缺失情况，降级为 0。
    """
    global _psutil_ready
    if _psutil_ready:
        return
    _psutil_ready = True  # 无论成功与否，只检查一次
    try:
        import psutil  # type: ignore
        psutil.cpu_percent(interval=None)
    except ImportError:
        # psutil 未安装时，admin 仍可运行，资源数据降级为 0
        logger.warning("psutil 未安装，系统资源数据将不可用")


def _collect_system() -> SystemResponse:
    """采集系统资源。psutil 缺失时降级。"""
    _ensure_psutil_ready()
    cpu_percent = 0.0
    mem_percent = 0.0
    mem_used = 0
    mem_total = 0
    disk_percent = 0.0
    disk_used = 0
    disk_total = 0
    try:
        import psutil  # type: ignore
        cpu_percent = psutil.cpu_percent(interval=None)
        mem = psutil.virtual_memory()
        mem_percent = mem.percent
        mem_used = mem.used
        mem_total = mem.total
        # 磁盘：取 DB 文件所在分区
        disk_path = os.path.dirname(os.path.abspath(_db_path)) or "."
        disk = psutil.disk_usage(disk_path)
        disk_percent = disk.percent
        disk_used = disk.used
        disk_total = disk.total
    except ImportError:
        pass
    except Exception:
        logger.exception("采集系统资源失败")

    db_size = _get_db_size()
    return SystemResponse(
        cpu_percent=round(cpu_percent, 1),
        mem_percent=round(mem_percent, 1),
        mem_used_bytes=mem_used,
        mem_total_bytes=mem_total,
        disk_percent=round(disk_percent, 1),
        disk_used_bytes=disk_used,
        disk_total_bytes=disk_total,
        db_size_bytes=db_size,
        server_uptime_seconds=int(time.time() - _server_started_at),
    )


def _get_db_size() -> int:
    """获取 DB 文件大小（字节）。"""
    try:
        return os.path.getsize(_db_path)
    except OSError:
        return 0


async def _collect_overview() -> OverviewResponse:
    """采集总览数据。"""
    # DAU：今天（UTC）调过 API 的账户去重数
    # devices.last_seen_at 在 verify_api_key 时更新，所有认证端点都会刷新
    dau_row = await _db.fetchone(
        "SELECT COUNT(DISTINCT account_id) as cnt FROM devices "
        "WHERE last_seen_at >= datetime('now', 'start of day')"
    )
    dau = dau_row["cnt"] if dau_row else 0

    # MAU：最近 30 天
    mau_row = await _db.fetchone(
        "SELECT COUNT(DISTINCT account_id) as cnt FROM devices "
        "WHERE last_seen_at >= datetime('now', '-30 days')"
    )
    mau = mau_row["cnt"] if mau_row else 0

    # 总账户数 / 总设备数
    acc_row = await _db.fetchone("SELECT COUNT(*) as cnt FROM accounts")
    total_accounts = acc_row["cnt"] if acc_row else 0
    dev_row = await _db.fetchone("SELECT COUNT(*) as cnt FROM devices")
    total_devices = dev_row["cnt"] if dev_row else 0

    # 在线连接数 + 在线账户数
    online_connections = _ws_manager.total_connections()
    # 有在线连接的账户数 = _connections 字典里的 key 数
    online_accounts = len(getattr(_ws_manager, "_connections", {}))

    # 全服务端配额使用（snapshots + sync_profiles，所有账户）
    quota_row = await _db.fetchone(
        "SELECT "
        "COALESCE((SELECT SUM(LENGTH(encrypted_value)) FROM sync_snapshots), 0) + "
        "COALESCE((SELECT SUM(LENGTH(sync_profile)) FROM devices), 0) as total"
    )
    quota_used = quota_row["total"] if quota_row else 0

    return OverviewResponse(
        dau=dau,
        mau=mau,
        online_connections=online_connections,
        online_accounts=online_accounts,
        total_accounts=total_accounts,
        total_devices=total_devices,
        quota_used_bytes=quota_used,
        quota_limit_bytes=_quota_bytes,
        server_uptime_seconds=int(time.time() - _server_started_at),
        db_size_bytes=_get_db_size(),
    )


async def _collect_accounts() -> AccountListResponse:
    """采集账户列表（含配额、设备数、最后活跃）。

    SQL 注意：devices 和 sync_snapshots 必须分别用子查询聚合后再 JOIN，
    不能直接三表 JOIN——否则会产生笛卡尔积（N 设备 × M 快照 = N×M 行），
    导致 SUM(LENGTH(encrypted_value)) 被放大 device_count 倍。
    """
    rows = await _db.fetchall(
        """
        SELECT
            a.id as account_id,
            a.created_at,
            COALESCE(dc.device_count, 0) as device_count,
            dc.last_active,
            COALESCE(sc.quota_used, 0) + COALESCE(dc.profile_size, 0) as quota_used
        FROM accounts a
        LEFT JOIN (
            SELECT account_id, COUNT(*) as device_count, MAX(last_seen_at) as last_active,
                   SUM(LENGTH(sync_profile)) as profile_size
            FROM devices
            GROUP BY account_id
        ) dc ON dc.account_id = a.id
        LEFT JOIN (
            SELECT account_id, SUM(LENGTH(encrypted_value)) as quota_used
            FROM sync_snapshots
            GROUP BY account_id
        ) sc ON sc.account_id = a.id
        ORDER BY quota_used DESC, last_active DESC
        """
    )

    online_accounts = set(getattr(_ws_manager, "_connections", {}).keys())

    items: list[AccountItem] = []
    for row in rows:
        items.append(AccountItem(
            account_id=row["account_id"],
            account_id_short=_short_id(row["account_id"]),
            device_count=row["device_count"],
            quota_used_bytes=row["quota_used"],
            quota_limit_bytes=_quota_bytes,
            last_active_at=row["last_active"],
            created_at=row["created_at"],
            online=row["account_id"] in online_accounts,
        ))

    return AccountListResponse(accounts=items, quota_limit_bytes=_quota_bytes)


async def _collect_devices(account_id: str) -> DeviceListResponse | None:
    """采集指定账户下的设备列表。

    注意：account_id 是用户传入的截断 ID，不能直接用于 SQL 查询（会匹配不到）。
    需要先在数据库里找到完整 ID 再查设备。
    """
    # 安全校验：account_id 只允许 hex 字符（account_id 是 SHA-256 hex）
    if not account_id or not all(c in "0123456789abcdef" for c in account_id.lower()):
        return None

    # 用前缀匹配找完整 account_id（前 8 位够唯一）
    row = await _db.fetchone(
        "SELECT id FROM accounts WHERE substr(id, 1, ?) = ?",
        (len(account_id), account_id.lower()),
    )
    if row is None:
        return None

    full_id = row["id"]
    online_devices = set(_ws_manager.get_online_devices(full_id))

    dev_rows = await _db.fetchall(
        "SELECT id, platform, last_seen_at FROM devices WHERE account_id = ? ORDER BY last_seen_at DESC",
        (full_id,),
    )
    devices = [
        DeviceItem(
            device_id_short=_short_id(r["id"]),
            platform=r["platform"],
            last_seen_at=r["last_seen_at"],
            online=r["id"] in online_devices,
        )
        for r in dev_rows
    ]
    return DeviceListResponse(account_id_short=_short_id(full_id), devices=devices)


# ── HTML 渲染（含 nonce 注入） ────────────────────────

def _render_html() -> tuple[str, str]:
    """渲染 HTML，返回 (html, nonce)。每次请求生成新 nonce。"""
    nonce = secrets.token_urlsafe(16)
    # 单次 replace，所有 {{NONCE}} 占位符统一替换
    html = _html_template.replace(_NONCE_PLACEHOLDER, nonce)
    return html, nonce


def _csp_header(nonce: str) -> str:
    """生成 Content-Security-Policy header。

    - default-src 'none'：默认全禁
    - script-src 'nonce-{nonce}'：只允许带 nonce 的内联脚本
    - style-src 'self' 'unsafe-inline' + Google Fonts：内联样式 + 字体样式表
    - font-src Google Fonts：字体文件
    - img-src 'self' data:：自身图片 + data URI（用于 SVG 图标）
    - connect-src 'self'：fetch 只能同源
    """
    return (
        "default-src 'none'; "
        f"script-src 'nonce-{nonce}'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' data:; "
        "connect-src 'self'; "
        "base-uri 'none'; "
        "form-action 'self'; "
        "frame-ancestors 'none'"
    )


# ── 路由创建 ──────────────────────────────────────────

def create_admin_router(
    admin_path: str,
    password_hash: str,
    session_ttl: int,
    ip_whitelist: list[str],
    db,
    ws_manager,
    sync_engine,
    quota_bytes: int,
    db_path: str,
) -> APIRouter:
    """创建 admin 路由。

    Args:
        admin_path: 面板入口路径（如 /admin_panela）
        password_hash: 密码的 SHA-256 hex
        session_ttl: session 有效期（秒）
        ip_whitelist: IP/CIDR 白名单（空表示不限）
        db: Database 实例
        ws_manager: ConnectionManager 实例
        sync_engine: SyncEngine 实例（当前未直接用，保留以备扩展）
        quota_bytes: 每账户配额上限
        db_path: SQLite 文件路径（用于磁盘统计 + 文件大小）
    """
    global _admin_password_hash, _admin_ip_whitelist, _admin_session_ttl, _admin_path
    global _db, _ws_manager, _sync_engine, _quota_bytes, _db_path, _html_template

    _admin_password_hash = password_hash
    _admin_ip_whitelist = ip_whitelist
    _admin_session_ttl = session_ttl
    _admin_path = admin_path
    _db = db
    _ws_manager = ws_manager
    _sync_engine = sync_engine
    _quota_bytes = quota_bytes
    _db_path = db_path

    # 读取 HTML 模板（启动时一次，避免每次请求 IO）
    html_path = Path(__file__).parent / "admin_panel.html"
    try:
        _html_template = html_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        logger.error("admin_panel.html 不存在: %s", html_path)
        _html_template = "<!DOCTYPE html><html><body>admin_panel.html 模板缺失</body></html>"

    router = APIRouter()

    # ── HTML 入口 ──────────────────────────────────
    @router.get("", response_class=HTMLResponse)
    async def admin_index(request: Request) -> HTMLResponse:
        # IP 白名单检查（HTML 入口也要检查，否则面板存在性泄露）
        client_ip = get_client_ip(request)
        if not _ip_allowed(client_ip, _admin_ip_whitelist):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)

        html, nonce = _render_html()
        return HTMLResponse(
            content=html,
            headers={
                "Content-Security-Policy": _csp_header(nonce),
                "X-Frame-Options": "DENY",
                "X-Content-Type-Options": "nosniff",
                "Referrer-Policy": "no-referrer",
                # 不返回 Access-Control-Allow-Origin，强制同源
            },
        )

    # ── 登录 ──────────────────────────────────────
    @router.post("/api/login", response_model=LoginResponse)
    async def admin_login(request: Request, body: LoginRequest) -> JSONResponse:
        client_ip = get_client_ip(request)

        # IP 白名单
        if not _ip_allowed(client_ip, _admin_ip_whitelist):
            # 404 而非 401，不暴露面板存在
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)

        # 速率限制（per-IP，5 次/分钟）
        if not _check_login_rate(client_ip):
            logger.warning("admin 登录限流触发: IP=%s", client_ip)
            return JSONResponse(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                content={"detail": "登录尝试过于频繁，请稍后再试"},
                headers={"Retry-After": str(_LOGIN_WINDOW_SEC)},
            )

        # 密码比对：常量时间，防时序攻击
        provided_hash = hashlib.sha256(body.password.encode("utf-8")).hexdigest()
        if not hmac.compare_digest(provided_hash, _admin_password_hash):
            # 审计日志：不记录密码、不记录提供的 hash
            logger.warning("admin 登录失败: IP=%s UA=%s", client_ip, request.headers.get("user-agent", "?")[:80])
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="密码错误")

        # 创建 session
        token, expires_in = _sessions.create(client_ip, _admin_session_ttl)
        logger.info("admin 登录成功: IP=%s", client_ip)
        return JSONResponse(
            content={"token": token, "expires_in": expires_in},
            headers={
                # 登录响应也带 CSP，防响应被当文档解析
                "Content-Security-Policy": _csp_header("login"),
                "X-Content-Type-Options": "nosniff",
            },
        )

    # ── 登出 ──────────────────────────────────────
    @router.post("/api/logout")
    async def admin_logout(request: Request, _: None = Depends(_require_admin)) -> JSONResponse:
        auth = request.headers.get("authorization", "")
        token = auth[7:] if auth.startswith("Bearer ") else ""
        _sessions.revoke(token)
        logger.info("admin 登出: IP=%s", get_client_ip(request))
        return JSONResponse(content={"status": "ok"})

    # ── 总览 ──────────────────────────────────────
    @router.get("/api/overview", response_model=OverviewResponse)
    async def admin_overview(_: None = Depends(_require_admin)) -> OverviewResponse:
        return await _collect_overview()

    # ── 系统资源 ──────────────────────────────────
    @router.get("/api/system", response_model=SystemResponse)
    async def admin_system(_: None = Depends(_require_admin)) -> SystemResponse:
        return _collect_system()

    # ── 账户列表 ──────────────────────────────────
    @router.get("/api/accounts", response_model=AccountListResponse)
    async def admin_accounts(_: None = Depends(_require_admin)) -> AccountListResponse:
        return await _collect_accounts()

    # ── 账户下设备 ────────────────────────────────
    @router.get("/api/accounts/{account_id}/devices", response_model=DeviceListResponse)
    async def admin_account_devices(
        account_id: str,
        _: None = Depends(_require_admin),
    ) -> DeviceListResponse:
        result = await _collect_devices(account_id)
        if result is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="账户不存在")
        return result

    return router
