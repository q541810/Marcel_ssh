"""服务端配置（TOML）。

配置来源：config.toml（默认 ./config.toml，可用 --config 指定）。
环境变量已全面废弃，所有配置走配置文件。

配置文件不存在 → 启动失败，提示复制 config.example.toml。

两种运行模式：
- 自部署（默认 hosted=false）：单租户无配额，CORS 允许所有来源。
- 托管模式（hosted=true）：多租户 + 配额限制，CORS 需显式配置。

字段详见 config.example.toml。
"""

from __future__ import annotations

import hashlib
import logging
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

# ── TOML 解析（Python 3.11+ 内置 tomllib，3.10 用 tomli）─────────
try:
    import tomllib  # type: ignore[attr-defined]
except ModuleNotFoundError:  # pragma: no cover - 3.10 走 tomli
    try:
        import tomli as tomllib  # type: ignore[no-redef]
    except ModuleNotFoundError:
        sys.stderr.write(
            "缺少 tomli 依赖（Python 3.10 需安装）。请运行：pip install tomli\n"
        )
        raise


# 默认配置文件路径（相对工作目录）
_DEFAULT_CONFIG_PATH = "./config.toml"


# admin_path 合法字符：字母数字 / _ -，必须以 / 开头
_ADMIN_PATH_PATTERN = re.compile(r"^/[A-Za-z0-9_/-]+$")

# 与主路由冲突的保留路径前缀，admin_path 不得命中
_RESERVED_ADMIN_PATHS = ("/", "/health", "/ws", "/api", "/openapi", "/docs", "/redoc")


def _parse_admin_path(raw: str) -> str:
    """校验并规范化 admin.path。

    规则：
    - 必须以 / 开头（自动补）
    - 仅允许 [A-Za-z0-9_/-]
    - 不得包含 .. 或 //
    - 不得与保留路径冲突（等于或作为保留路径的前缀）
    - 去除尾部斜杠（根路径除外）
    """
    path = raw.strip()
    if not path:
        return "/admin_panela"
    if not path.startswith("/"):
        path = "/" + path
    if len(path) > 1:
        path = path.rstrip("/")
    if not _ADMIN_PATH_PATTERN.match(path):
        raise ValueError(f"admin.path 含非法字符: {raw!r}")
    if ".." in path or "//" in path:
        raise ValueError(f"admin.path 含非法序列 .. 或 //: {raw!r}")
    for reserved in _RESERVED_ADMIN_PATHS:
        if path == reserved or path.startswith(reserved + "/"):
            raise ValueError(f"admin.path 与保留路径冲突: {path}")
    return path


@dataclass(frozen=True)
class ServerConfig:
    hosted_mode: bool
    db_path: str
    host: str
    port: int
    workers: int
    max_devices_per_account: int
    account_quota_bytes: int
    cors_origins: list[str]
    ws_ping_interval: int
    ws_ping_timeout: int
    trusted_proxy_ips: list[str]
    # admin 面板配置
    admin_enabled: bool = False
    admin_path: str = "/admin_panela"
    admin_password_hash: str = ""  # SHA-256 hex，空表示未配置
    admin_session_ttl: int = 3600
    admin_ip_whitelist: list[str] = field(default_factory=list)
    # 维护任务
    cleanup_empty_accounts_enabled: bool = True
    cleanup_empty_accounts_hour: int = 4  # UTC 小时，0-23

    @property
    def is_hosted(self) -> bool:
        return self.hosted_mode


def _get(d: dict, section: str, key: str, default, cast=None):
    """从嵌套 dict 取值，缺失或类型错返回 default。"""
    try:
        v = d.get(section, {}).get(key, default)
    except (AttributeError, TypeError):
        return default
    if v is None:
        return default
    if cast is not None and not isinstance(v, cast):
        logger.warning("config: [%s].%s 类型不符（期望 %s，实际 %s），用默认值",
                       section, key, cast, type(v).__name__)
        return default
    return v


def load_config(config_path: str | None = None) -> ServerConfig:
    """加载配置文件并构建 ServerConfig。

    Args:
        config_path: 配置文件路径。None 用默认 ./config.toml。
    """
    path = Path(config_path) if config_path else Path(_DEFAULT_CONFIG_PATH)

    if not path.exists():
        sys.stderr.write(
            f"配置文件不存在: {path}\n"
            "请复制模板：cp config.example.toml config.toml\n"
            "或指定路径：python main.py --config /path/to/config.toml\n"
        )
        raise SystemExit(1)

    with path.open("rb") as f:
        raw = tomllib.load(f)

    # ── [server] ──────────────────────────────────
    hosted = _get(raw, "server", "hosted", False, bool)
    db_path = _get(raw, "server", "db_path", "./data/marcel_sync.db", str)
    host = _get(raw, "server", "host", "0.0.0.0", str)
    port = _get(raw, "server", "port", 8787, int)
    workers = _get(raw, "server", "workers", 1, int)
    if workers != 1:
        logger.warning(
            "[server].workers=%s，但当前 SQLite 单连接不支持多 worker，强制改为 1", workers
        )
        workers = 1
    max_devices = _get(raw, "server", "max_devices_per_account",
                       10 if hosted else 100, int)
    quota = _get(raw, "server", "account_quota_bytes",
                 200 * 1024 * 1024 if hosted else 0, int)
    cors_origins = _get(raw, "server", "cors_origins",
                        ["*"] if not hosted else [], list)
    # CORS 字符串清洗
    cors_origins = [str(o).strip() for o in cors_origins if str(o).strip()]

    # ── [websocket] ───────────────────────────────
    ws_ping_interval = _get(raw, "websocket", "ping_interval", 20, int)
    ws_ping_timeout = _get(raw, "websocket", "ping_timeout", 60, int)

    # ── [proxy] ───────────────────────────────────
    trusted_ips = _get(raw, "proxy", "trusted_ips",
                       ["127.0.0.1", "::1", "localhost"], list)
    trusted_ips = [str(o).strip() for o in trusted_ips if str(o).strip()]

    # ── [admin] ───────────────────────────────────
    admin_enabled = _get(raw, "admin", "enabled", False, bool)

    # 路径校验：失败时记录错误并回退默认（不阻断主服务启动）
    try:
        admin_path = _parse_admin_path(_get(raw, "admin", "path", "/admin_panela", str))
    except ValueError as e:
        logger.error("admin 面板路径配置非法，已回退默认 /admin_panela: %s", e)
        admin_path = "/admin_panela"

    # 密码：优先 hash，其次明文（启动时 hash 入内存）
    admin_password_hash = _get(raw, "admin", "password_hash", "", str).strip().lower()
    admin_password_plain = _get(raw, "admin", "password", "", str).strip()
    if not admin_password_hash and admin_password_plain:
        admin_password_hash = hashlib.sha256(admin_password_plain.encode("utf-8")).hexdigest()
        # 明文密码不落日志，仅提示应改用 hash
        logger.warning("admin.password 使用明文配置，建议改用 admin.password_hash")

    # 启用但未配置密码 → 强制关闭，记录错误（不阻断主服务）
    if admin_enabled and not admin_password_hash:
        logger.error("admin.enabled=true 但未配置密码（admin.password_hash 或 admin.password），admin 面板已强制关闭")
        admin_enabled = False

    admin_session_ttl = _get(raw, "admin", "session_ttl", 3600, int)
    admin_ip_whitelist = _get(raw, "admin", "ip_whitelist", [], list)
    admin_ip_whitelist = [str(o).strip() for o in admin_ip_whitelist if str(o).strip()]

    # ── [maintenance] ─────────────────────────────
    cleanup_enabled = _get(raw, "maintenance", "cleanup_empty_accounts_enabled", True, bool)
    cleanup_hour = _get(raw, "maintenance", "cleanup_empty_accounts_hour", 4, int)
    if not 0 <= cleanup_hour <= 23:
        logger.warning("[maintenance].cleanup_empty_accounts_hour=%s 超出 0-23，回退默认 4", cleanup_hour)
        cleanup_hour = 4

    return ServerConfig(
        hosted_mode=hosted,
        db_path=db_path,
        host=host,
        port=port,
        workers=workers,
        max_devices_per_account=max_devices,
        account_quota_bytes=quota,
        cors_origins=cors_origins,
        ws_ping_interval=ws_ping_interval,
        ws_ping_timeout=ws_ping_timeout,
        trusted_proxy_ips=trusted_ips,
        admin_enabled=admin_enabled,
        admin_path=admin_path,
        admin_password_hash=admin_password_hash,
        admin_session_ttl=admin_session_ttl,
        admin_ip_whitelist=admin_ip_whitelist,
        cleanup_empty_accounts_enabled=cleanup_enabled,
        cleanup_empty_accounts_hour=cleanup_hour,
    )
