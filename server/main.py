"""Marcel SSH 同步服务端入口。

启动方式：
    cd server
    pip install -r requirements.txt
    cp config.example.toml config.toml  # 首次部署
    python main.py                       # 推荐：host/port/workers 从 config.toml 读

配置走 config.toml（默认 ./config.toml），不再支持环境变量。
自定义配置路径：
    python main.py --config /etc/marcel-sync/config.toml

开发模式（需要热重载）：
    uvicorn main:app --reload --port 8787
    注意：开发模式下 host/port 由 uvicorn 命令行参数控制，不读 config.toml。

两种模式（config.toml 的 [server].hosted）：
- 自部署（默认 hosted=false）：无配额，CORS *
- 托管模式（hosted=true）：有配额，需配置 cors_origins
"""

from __future__ import annotations

import asyncio
import logging
import sys
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from config import ServerConfig, load_config
from db import Database
from auth import AuthManager, sha256_hex
from device import DeviceManager
from sync import SyncEngine, QuotaExceededError
from ws import ConnectionManager
from rate_limit import rate_limit_middleware, RateLimiter, get_client_ip, set_trusted_proxy_ips
from models import (
    AccountSetupRequest,
    AccountSetupResponse,
    AccountJoinRequest,
    AccountJoinResponse,
    AccountDeleteRequest,
    DeviceRegisterRequest,
    DeviceRegisterResponse,
    SyncProfileUpdateRequest,
    DeviceInfoResponse,
    PushRequest,
    PushResponse,
    PullRequest,
    PullResponse,
    SnapshotResponse,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


def _detect_config_path() -> str | None:
    """从命令行参数预扫描 --config，不依赖 argparse。

    模块导入时即执行（uvicorn main:app 和 python main.py 都走这里），
    避免双重初始化全局实例。完整 argparse 帮助在 __main__ 块里。
    """
    args = sys.argv[1:]
    for i, arg in enumerate(args):
        if arg == "--config" and i + 1 < len(args):
            return args[i + 1]
        if arg.startswith("--config="):
            return arg.split("=", 1)[1]
    return None


# ── 全局实例 ──────────────────────────────────────────

config: ServerConfig = load_config(_detect_config_path())
db = Database(config.db_path)
auth = AuthManager(db)
device_mgr = DeviceManager(db, auth)
sync_engine = SyncEngine(db)
ws_manager = ConnectionManager()

# 注入配置
device_mgr.set_max_devices(config.max_devices_per_account)
sync_engine.set_quota(config.account_quota_bytes)
ws_manager.set_ping_config(config.ws_ping_interval, config.ws_ping_timeout)
# 注入可信反代 IP（原 rate_limit.py 自己读环境变量，现统一走 config.toml）
set_trusted_proxy_ips(config.trusted_proxy_ips)


# ── 生命周期 ──────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.init()
    logger.info(
        "数据库初始化完成: %s（模式: %s）",
        config.db_path,
        "托管" if config.is_hosted else "自部署",
    )
    # 启动每日空账户清理任务（默认 UTC 04:00）
    cleanup_task = None
    if config.cleanup_empty_accounts_enabled:
        cleanup_task = asyncio.create_task(_cleanup_empty_accounts_loop())
        logger.info(
            "空账户清理任务已启动，每日 UTC %02d:00 执行",
            config.cleanup_empty_accounts_hour,
        )
    else:
        logger.info("空账户清理任务已禁用")

    yield

    if cleanup_task is not None:
        cleanup_task.cancel()
        try:
            await cleanup_task
        except asyncio.CancelledError:
            pass
    await db.close()
    logger.info("数据库已关闭")


async def _cleanup_empty_accounts_loop() -> None:
    """每日定时清理设备数为 0 的账户。

    策略：循环计算到下一次 UTC `cleanup_empty_accounts_hour:00` 的等待秒数并 sleep。
    服务启动时若已过当天该时刻，则等到次日；未过则在当天执行。
    每次执行后重新计算下一次时间，避免长时间运行后的漂移。
    """
    import datetime as _dt

    while True:
        try:
            now = _dt.datetime.now(_dt.timezone.utc)
            target = now.replace(
                hour=config.cleanup_empty_accounts_hour,
                minute=0,
                second=0,
                microsecond=0,
            )
            if now >= target:
                target += _dt.timedelta(days=1)
            wait_secs = (target - now).total_seconds()
            await asyncio.sleep(wait_secs)

            deleted = await auth.cleanup_empty_accounts()
            if deleted > 0:
                logger.info("空账户清理：删除 %d 个无设备账户", deleted)
            else:
                logger.debug("空账户清理：本次无账户需清理")
        except asyncio.CancelledError:
            raise
        except Exception:
            # 不让异常中断循环；下次到点重试
            logger.exception("空账户清理任务异常，将在下次到点重试")
            await asyncio.sleep(60)


app = FastAPI(
    title="Marcel SSH Sync Server",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS 配置
# 安全说明：
# - 当前认证用 Bearer Token（非 Cookie），不需要 allow_credentials=True
# - 自部署模式 allow_origins=["*"]，若同时 allow_credentials=True 会触发 starlette 变通行为：
#   回显请求 Origin + Access-Control-Allow-Credentials: true，等于全开 + 允许凭证（致命组合）
# - 因此 allow_credentials 统一为 False；若未来引入 web 客户端 + Cookie 认证再单独处理
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# IP 级速率限制（防止暴力枚举 / 资源耗尽 DoS）
# 对 setup/join/delete 等公开端点严格限制，对认证端点宽松
app.middleware("http")(rate_limit_middleware)

# 请求体大小限制（防止大 payload OOM 攻击）
# 20MB 上限：足够一次推送 1000 条平均 20KB 的变更
MAX_BODY_BYTES = 20 * 1024 * 1024


class MaxBodySizeMiddleware:
    """ASGI 中间件：拦截 receive 事件统计实际接收字节数，超限截断 body。

    必须在 ASGI 层（而非 HTTP 中间件层）实现，原因：
    - HTTP 中间件只能检查 Content-Length header
    - Transfer-Encoding: chunked 请求没有 Content-Length，可绕过 header 检查
    - 只有 ASGI 层能拦截 http.request 事件的 body chunks，统计真实接收字节数

    超限处理：返回空 body + more_body=False，让下游 Pydantic 收到不完整 JSON
    解析失败返回 422。虽不是标准 413，但效果一致（拒绝请求），
    且避免了 app 反序列化大 JSON 的 OOM 风险。
    """

    def __init__(self, app, max_bytes: int):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        total_received = 0
        truncated = False

        async def limited_receive():
            nonlocal total_received, truncated
            if truncated:
                # 已截断，继续返回空消息让 app 结束读取
                return {"type": "http.request", "body": b"", "more_body": False}

            message = await receive()
            if message["type"] == "http.request":
                body_chunk = message.get("body", b"")
                total_received += len(body_chunk)
                if total_received > self.max_bytes:
                    truncated = True
                    # 返回空 body + more_body=False，让 app 以为 body 已结束
                    # 下游 Pydantic 解析被截断的 JSON 失败，返回 422
                    return {"type": "http.request", "body": b"", "more_body": False}
            return message

        await self.app(scope, limited_receive, send)


# 用 ASGI 中间件替代 HTTP 中间件，真正拦截 chunked transfer-encoding
app.add_middleware(MaxBodySizeMiddleware, max_bytes=MAX_BODY_BYTES)

# WS 握手级速率限制实例（WebSocket 不走 HTTP 中间件，需在端点内手动检查）
ws_handshake_limiter = RateLimiter()


# ── 认证依赖 ──────────────────────────────────────────


async def verify_auth(authorization: str = Header(...)) -> tuple[str, str]:
    """从 Authorization header 提取并验证 API Key，返回 (account_id, device_id)。"""
    if not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization header 必须是 Bearer 格式",
        )
    api_key = authorization[7:]  # 去掉 "Bearer "
    result = await auth.verify_api_key(api_key)
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="无效的 API Key",
        )
    return result


# ── 健康检查 ──────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "mode": "hosted" if config.is_hosted else "self-hosted"}


# ── 账户路由 ──────────────────────────────────────────

@app.post("/api/account/setup", response_model=AccountSetupResponse)
async def setup_account(request: AccountSetupRequest):
    """第一台设备注册账户。

    客户端流程：
    1. 生成 32 位随机配置码
    2. 生成 256 位随机 Sync Key，存入 keychain
    3. account_id = SHA-256(配置码)
    4. api_key = 设备 API Key，api_key_hash = SHA-256(api_key)
    5. 包装密钥 = HKDF(配置码)，encrypted_sync_key = AES-GCM(包装密钥, Sync Key)
    6. 调用此接口注册
    """
    try:
        # 生成设备 API Key
        from auth import generate_api_key
        api_key = generate_api_key()
        api_key_hash = sha256_hex(api_key)

        await auth.setup_account(
            config_code_hash=request.config_code_hash,
            api_key_hash=api_key_hash,
            encrypted_sync_key=request.encrypted_sync_key,
            device_id=request.device_id,
            platform=request.platform,
            sync_profile=request.sync_profile,
        )

        logger.info(
            "新账户注册: %s, 设备: %s",
            request.config_code_hash[:8] + "…",
            request.device_id[:8] + "…",
        )
        return AccountSetupResponse(
            account_id=request.config_code_hash,
            device_id=request.device_id,
            api_key=api_key,
        )
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))


@app.post("/api/account/join", response_model=AccountJoinResponse)
async def join_account(request: AccountJoinRequest):
    """后续设备加入已有账户，并注册本设备。

    客户端流程：
    1. 用户输入配置码
    2. config_code_hash = SHA-256(配置码)
    3. 生成本设备 device_id + sync_profile
    4. 调用此接口：校验账户 → 返回 encrypted_sync_key + 注册设备 + 返回 api_key
    5. 包装密钥 = HKDF(配置码)，Sync Key = AES-GCM-Decrypt(包装密钥, encrypted_sync_key)
    6. 将 Sync Key / device_id / api_key 存入 keychain

    注意：设备注册必须在 join 内完成。/api/device/register 需要已有 API Key，
    新设备没有凭证，不能拆成两步。
    """
    encrypted_sync_key = await auth.get_encrypted_sync_key(request.config_code_hash)
    if encrypted_sync_key is None:
        raise HTTPException(status_code=404, detail="账户不存在，请检查配置码")

    try:
        register_resp = await device_mgr.register_device(
            request.config_code_hash,
            DeviceRegisterRequest(
                device_id=request.device_id,
                platform=request.platform,
                sync_profile=request.sync_profile,
            ),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    logger.info(
        "设备加入账户: %s, 设备: %s",
        request.config_code_hash[:8] + "…",
        request.device_id[:8] + "…",
    )
    return AccountJoinResponse(
        account_id=request.config_code_hash,
        encrypted_sync_key=encrypted_sync_key,
        device_id=register_resp.device_id,
        api_key=register_resp.api_key,
    )


@app.delete("/api/account")
async def delete_account(
    request: AccountDeleteRequest,
    auth_ctx: tuple[str, str] = Depends(verify_auth),
):
    """账户重置：删除账户及所有数据。

    认证要求：
    - 必须持有该账户的有效 API Key（verify_auth 依赖）。API Key 即代表对该账户的完全访问权，
      一旦泄露，持有者可读写并删除账户全部数据。
    - 请求体内的 config_code_hash 必须与 API Key 所属账户一致（一致性校验）。

    说明：上述第二点并非独立「第二因子」。合法设备本就持有自身 account_id
          （= config_code_hash，setup/join 响应中已返回并存储），因此该检查对合法
          调用者恒为真，仅作一致性/防误用保护，不构成额外的身份因子。
          真正的删除授权完全来自 API Key，请勿在文档/审计中声称存在「双因子」防护。
    - 级联删除 devices 和 sync_snapshots（外键 ON DELETE CASCADE）
    - 所有在线 WebSocket 连接会被踢
    """
    account_id, _ = auth_ctx

    # 一致性校验：请求体的 config_code_hash 必须与 API Key 所属账户一致（非独立第二因子）
    if account_id != request.config_code_hash:
        # 不泄露账户是否存在，统一返回 403
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="config_code_hash 与认证账户不匹配",
        )

    # 踢掉该账户所有在线设备
    for device_id in ws_manager.get_online_devices(request.config_code_hash):
        # 这里只清理连接池，实际 WebSocket 关闭由客户端检测到断开后自行处理
        await ws_manager.disconnect(request.config_code_hash, device_id)

    success = await auth.delete_account(request.config_code_hash)
    if not success:
        raise HTTPException(status_code=404, detail="账户不存在")

    logger.info("账户已删除: %s", request.config_code_hash[:8] + "…")
    return {"status": "deleted"}


# ── 设备路由 ──────────────────────────────────────────

@app.post("/api/device/register", response_model=DeviceRegisterResponse)
async def register_device(
    request: DeviceRegisterRequest,
    auth_ctx: tuple[str, str] = Depends(verify_auth),
):
    """注册新设备（join 之后调用）。

    需要已 join 的设备持有有效 API Key 才能调用。
    """
    account_id, _ = auth_ctx
    try:
        return await device_mgr.register_device(account_id, request)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.put("/api/device/sync_profile")
async def update_sync_profile(
    request: SyncProfileUpdateRequest,
    auth_ctx: tuple[str, str] = Depends(verify_auth),
):
    """更新设备的 sync_profile。"""
    account_id, _ = auth_ctx
    try:
        await device_mgr.update_sync_profile(account_id, request)
        return {"status": "ok"}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.get("/api/devices", response_model=list[DeviceInfoResponse])
async def list_devices(auth_ctx: tuple[str, str] = Depends(verify_auth)):
    """列出账户下所有设备。"""
    account_id, _ = auth_ctx
    return await device_mgr.get_devices(account_id)


@app.delete("/api/device/{device_id}")
async def delete_device(
    device_id: str,
    auth_ctx: tuple[str, str] = Depends(verify_auth),
):
    """删除（撤销）某设备的 API Key。

    安全措施：
    - 删除后立即踢该设备的 WebSocket 连接（防止已删除设备继续接收通知）
    """
    account_id, _ = auth_ctx
    success = await device_mgr.delete_device(account_id, device_id)
    if not success:
        raise HTTPException(status_code=404, detail="设备不存在")

    # 立即踢该设备的 WebSocket 连接（防止已撤销的设备继续接收 push 通知）
    await ws_manager.disconnect(account_id, device_id)

    return {"status": "deleted"}


# ── 同步路由 ──────────────────────────────────────────

@app.post("/api/sync/push", response_model=PushResponse)
async def push(
    request: PushRequest,
    auth_ctx: tuple[str, str] = Depends(verify_auth),
):
    """推送本地变更到服务端。"""
    account_id, device_id = auth_ctx
    try:
        result = await sync_engine.push(account_id, device_id, request)
        # 通知同账户其他在线设备
        await ws_manager.notify_changes(account_id, device_id)
        return result
    except QuotaExceededError as e:
        raise HTTPException(status_code=413, detail=str(e))


@app.post("/api/sync/pull", response_model=PullResponse)
async def pull(
    request: PullRequest,
    auth_ctx: tuple[str, str] = Depends(verify_auth),
):
    """增量拉取：只返回 version > 客户端持有版本的项。"""
    account_id, _ = auth_ctx
    return await sync_engine.pull(account_id, request)


@app.get("/api/sync/snapshot", response_model=SnapshotResponse)
async def snapshot(auth_ctx: tuple[str, str] = Depends(verify_auth)):
    """全量快照拉取（新设备首次同步用）。"""
    account_id, _ = auth_ctx
    return await sync_engine.snapshot(account_id)


# ── WebSocket ────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    """WebSocket 连接。

    认证方式（按优先级）：
    1. Authorization: Bearer <api_key> header（推荐，Tauri/reqwest 场景）
    2. Sec-WebSocket-Protocol: bearer.<api_key> 子协议（浏览器场景）
    废弃：query param ?token=<api_key>（会泄露到 access log / Referer）

    安全措施：
    - 握手级速率限制（10 次/分钟/IP）防 FD 耗尽
    - Origin 校验（仅浏览器场景）防 CSWSH 跨站 WebSocket 劫持
    - 单账户连接数上限（max_devices × 2）防资源耗尽
    - 认证失败立即关闭（code 4001）
    """
    # 握手级 rate limit（WS 不走 HTTP 中间件）
    client_ip = get_client_ip(ws)
    if ws_handshake_limiter.should_block(client_ip, "/ws"):
        await ws.accept()
        await ws.close(code=4029, reason="握手过于频繁，请稍后再试")
        return

    # Origin 校验（防 CSWSH 跨站 WebSocket 劫持）
    # 仅当客户端发来 Origin 时校验（浏览器必发；Tauri/reqwest 不发）
    origin = ws.headers.get("origin")
    if origin:
        # "*" 表示允许任意 Origin（自部署模式）
        if "*" not in config.cors_origins and origin not in config.cors_origins:
            await ws.accept()
            await ws.close(code=4003, reason="Origin 不被允许")
            return

    # 提取 token（按优先级）
    token: str | None = None
    subprotocol: str | None = None

    # 1. Authorization header
    auth_header = ws.headers.get("authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header[7:]
    else:
        # 2. Sec-WebSocket-Protocol 子协议（格式：bearer.<api_key>）
        offered = ws.headers.get("sec-websocket-protocol", "")
        for proto in offered.split(","):
            proto = proto.strip()
            if proto.startswith("bearer."):
                token = proto[7:]
                subprotocol = proto
                break

    if not token:
        await ws.accept()
        await ws.close(code=4001, reason="缺少认证信息（Authorization 或 Sec-WebSocket-Protocol）")
        return

    result = await auth.verify_api_key(token)
    if result is None:
        # accept 时回显子协议以满足浏览器握手要求
        await ws.accept(subprotocol=subprotocol)
        await ws.close(code=4001, reason="无效的 API Key")
        return

    account_id, device_id = result

    # 查询设备 platform
    devices = await device_mgr.get_devices(account_id)
    platform = next((d.platform for d in devices if d.device_id == device_id), "unknown")

    # 连接数上限校验（防止单账户 FD 耗尽）
    online = ws_manager.get_online_devices(account_id)
    if len(online) >= config.max_devices_per_account * 2:
        await ws.accept(subprotocol=subprotocol)
        await ws.close(code=4031, reason="账户在线连接数已达上限")
        return

    # 全局连接数上限校验（防止多账户协同 FD 耗尽）
    if ws_manager.is_at_global_limit():
        await ws.accept(subprotocol=subprotocol)
        await ws.close(code=4032, reason="服务器连接数已达上限，请稍后再试")
        return

    await ws_manager.connect(ws, account_id, device_id, platform, subprotocol=subprotocol)

    # idle 超时：客户端在 ws_ping_timeout 秒内未发任何消息则关闭连接
    # 这防止僵尸连接（客户端崩溃/网络中断但 TCP 未感知）占用 FD
    # 客户端应定期发 ping 消息保活（如每 ws_ping_interval 秒发一次）
    idle_timeout = config.ws_ping_interval + config.ws_ping_timeout

    try:
        while True:
            # 用 wait_for 包装 receive_text，超时则关闭连接
            await asyncio.wait_for(
                ws.receive_text(),
                timeout=idle_timeout,
            )
    except asyncio.TimeoutError:
        logger.info("WebSocket idle 超时，关闭连接: 设备 %s", device_id[:8] + "…")
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("WebSocket 异常，设备 %s", device_id[:8] + "…")
    finally:
        await ws_manager.disconnect(account_id, device_id)


# ── Admin 监控面板（条件挂载） ────────────────────────
# 安全要点：
# - 默认关闭（config.admin_enabled=false），关闭时路由根本不注册
#   扫到 /admin_panela 也返回 404，与不存在路径无差别
# - 启用时路径来自 config.admin_path（默认 /admin_panela，可在 [admin].path 自定义）
# - 密码、session、限流、IP 白名单、CSP 等安全措施在 admin_panel.py 内实现
if config.admin_enabled:
    from admin_panel import create_admin_router

    admin_router = create_admin_router(
        admin_path=config.admin_path,
        password_hash=config.admin_password_hash,
        session_ttl=config.admin_session_ttl,
        ip_whitelist=config.admin_ip_whitelist,
        db=db,
        ws_manager=ws_manager,
        sync_engine=sync_engine,
        quota_bytes=config.account_quota_bytes,
        db_path=config.db_path,
    )
    app.include_router(admin_router, prefix=config.admin_path)
    logger.info(
        "Admin 监控面板已启用: 入口 %s（IP 白名单: %s）",
        config.admin_path,
        "已配置 " + str(len(config.admin_ip_whitelist)) + " 条" if config.admin_ip_whitelist else "未限制",
    )
else:
    logger.info("Admin 监控面板未启用（[admin].enabled=false）")


if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(
        description="Marcel SSH 同步服务端",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "host/port/workers 从 config.toml 的 [server] 段读取，不在命令行指定。\n"
            "配置文件默认 ./config.toml，可复制 config.example.toml 修改。\n"
            "示例：\n"
            "  python main.py                                       # 读默认 ./config.toml\n"
            "  python main.py --config /etc/marcel-sync/config.toml # 指定配置路径\n"
            "  uvicorn main:app --reload                            # 开发模式（不读 config 的 host/port）"
        ),
    )
    parser.add_argument("--config", default=None,
                        help="配置文件路径（默认 ./config.toml）")
    args = parser.parse_args()

    # host/port/workers 全部从 config.toml 读取（config 已在模块导入时加载）
    uvicorn.run(app, host=config.host, port=config.port, workers=config.workers)
