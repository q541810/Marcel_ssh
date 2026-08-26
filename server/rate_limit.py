"""IP 级滑动窗口速率限制。

设计：
- 内存存储（单进程多 worker 下每个 worker 独立计数，足够防止单点滥用）
- 滑动窗口算法：记录最近 N 秒内的请求时间戳，超出阈值即拒绝
- 按端点分组（防止一个严格端点的计数影响另一个）
- 周期性清理过期条目避免内存泄漏

客户端 IP：
- 默认只用 TCP 对端（request.client.host），不信任客户端可伪造的 X-Forwarded-For
- 仅当对端 IP 在 trusted_proxy_ips 白名单内时，才读取 X-Real-IP / X-Forwarded-For
- 白名单由 main.py 启动时从 config.toml 的 [proxy].trusted_ips 注入（set_trusted_proxy_ips）
- 默认白名单：127.0.0.1、::1、localhost（本机 Nginx 反代）
"""

from __future__ import annotations

import time
from threading import Lock
from typing import Callable, Awaitable, Any

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.responses import Response


# ── 速率配置 ──────────────────────────────────────────

# 端点路径 → (max_requests, window_seconds)
RATE_LIMITS: dict[str, tuple[int, int]] = {
    "/api/account/setup":   (3, 60),
    "/api/account/join":    (5, 60),
    "/api/account":         (5, 60),  # DELETE
    "/api/account/quota":   (60, 60),  # GET 配额查询（低频读，与同步类端点一致）
    "/api/device/register": (10, 60),
    "/api/sync/push":       (60, 60),
    "/api/sync/pull":       (60, 60),
    "/api/sync/snapshot":   (10, 60),
    "/ws":                  (10, 60),
}

DEFAULT_LIMIT = (120, 60)  # 其他端点默认 120/分钟

# 默认只信任本机反代；公网直连绝不信 XFF
_DEFAULT_TRUSTED_PROXIES = ["127.0.0.1", "::1", "localhost"]


def _normalize_ip(ip: str) -> str:
    s = ip.strip().lower()
    if s in ("localhost", "::ffff:127.0.0.1"):
        return "127.0.0.1"
    return s


# 进程级可信反代 IP 集合，由 main.py 启动时注入。
# 未注入时用默认值（本机反代），保证 rate_limit 模块单独导入也能工作。
_TRUSTED_PROXY_IPS: frozenset[str] = frozenset(
    _normalize_ip(p) for p in _DEFAULT_TRUSTED_PROXIES
)


def set_trusted_proxy_ips(ips: list[str]) -> None:
    """由 main.py 启动时注入 config.toml 的 [proxy].trusted_ips。

    - 自动补全 localhost 别名（127.0.0.1 / ::1 互通）
    - 改配置需重启服务
    """
    global _TRUSTED_PROXY_IPS
    parts = [_normalize_ip(p) for p in ips if p.strip()]
    out: set[str] = set(parts)
    if "127.0.0.1" in out:
        out.add("localhost")
        out.add("::1")
    if "localhost" in out:
        out.add("127.0.0.1")
        out.add("::1")
    _TRUSTED_PROXY_IPS = frozenset(out)


def get_trusted_proxy_ips() -> frozenset[str]:
    return _TRUSTED_PROXY_IPS


def parse_limit(spec: str) -> tuple[int, int]:
    """解析 '5/minute' 格式。"""
    num, unit = spec.split("/")
    n = int(num)
    if unit.startswith("minute"):
        return n, 60
    if unit.startswith("second"):
        return n, 1
    if unit.startswith("hour"):
        return n, 3600
    raise ValueError(f"未知时间单位: {unit}")


# ── 滑动窗口实现 ──────────────────────────────────────

class SlidingWindow:
    """单 key 的滑动窗口计数器。"""

    def __init__(self, max_requests: int, window_seconds: int):
        self.max = max_requests
        self.window = window_seconds
        self.timestamps: list[float] = []
        self._lock = Lock()

    def allow(self) -> bool:
        """是否允许请求。线程安全。"""
        now = time.monotonic()
        cutoff = now - self.window
        with self._lock:
            self.timestamps = [t for t in self.timestamps if t > cutoff]
            if len(self.timestamps) >= self.max:
                return False
            self.timestamps.append(now)
            return True


class RateLimiter:
    """按 (ip, path) 维度限流。"""

    def __init__(self):
        self._windows: dict[tuple[str, str], SlidingWindow] = {}
        self._global_lock = Lock()

    def _get_window(self, ip: str, path_key: str) -> SlidingWindow:
        key = (ip, path_key)
        with self._global_lock:
            win = self._windows.get(key)
            if win is None:
                max_req, win_sec = RATE_LIMITS.get(path_key, DEFAULT_LIMIT)
                win = SlidingWindow(max_req, win_sec)
                self._windows[key] = win
            return win

    def should_block(self, ip: str, path_key: str) -> bool:
        win = self._get_window(ip, path_key)
        return not win.allow()

    def cleanup_stale(self, max_age_seconds: int = 600) -> None:
        now = time.monotonic()
        cutoff = now - max_age_seconds
        with self._global_lock:
            stale_keys = [
                key for key, win in self._windows.items()
                if not win.timestamps or win.timestamps[-1] <= cutoff
            ]
            for key in stale_keys:
                del self._windows[key]


_limiter = RateLimiter()
_last_cleanup = time.monotonic()
_CLEANUP_INTERVAL = 600


def get_client_ip(request: Any) -> str:
    """获取用于限流的客户端 IP。

    - 对端不在 [proxy].trusted_ips 内：只用 TCP peer，忽略一切转发头（防伪造）。
    - 对端在白名单内（如本机 Nginx）：才采信 X-Real-IP，其次 X-Forwarded-For 最左段。

    request 可为 Starlette Request 或 WebSocket（均有 .client / .headers）。
    """
    peer = "unknown"
    if getattr(request, "client", None) is not None and request.client is not None:
        peer = request.client.host or "unknown"

    peer_n = _normalize_ip(peer)
    trusted = get_trusted_proxy_ips()
    if peer_n not in trusted and peer not in trusted:
        return peer

    headers = getattr(request, "headers", None)
    if headers is None:
        return peer

    # 反代场景：优先 X-Real-IP（Nginx 应设为 $remote_addr）
    xri = headers.get("x-real-ip")
    if xri and xri.strip():
        return xri.strip()

    xff = headers.get("x-forwarded-for")
    if xff:
        # 从右往左取第一个不在 trusted_ips 内的 IP 作为真实客户端 IP
        parts = [p.strip() for p in xff.split(",") if p.strip()]
        for ip in reversed(parts):
            ip_n = _normalize_ip(ip)
            if ip_n not in trusted and ip not in trusted:
                return ip
        # 全链均在 trusted_ips（极少见），回退最左端
        if parts:
            return parts[0]

    return peer


def _path_key(path: str) -> str:
    return path


async def rate_limit_middleware(request: Request, call_next: Callable[[Request], Awaitable[Response]]):
    """FastAPI HTTP 中间件：基于 IP + path 的速率限制。"""
    global _last_cleanup

    now = time.monotonic()
    if now - _last_cleanup > _CLEANUP_INTERVAL:
        _limiter.cleanup_stale()
        _last_cleanup = now

    path = request.url.path
    path_key = _path_key(path)

    if path == "/health":
        return await call_next(request)

    ip = get_client_ip(request)
    if _limiter.should_block(ip, path_key):
        max_req, win_sec = RATE_LIMITS.get(path_key, DEFAULT_LIMIT)
        return JSONResponse(
            status_code=429,
            content={"detail": f"请求过于频繁，每 {win_sec} 秒最多 {max_req} 次"},
            headers={"Retry-After": str(win_sec)},
        )

    return await call_next(request)
