"""WebSocket 连接管理与变更通知。

设计：
- 每个账户维护一个连接集合（account_id → set[WebSocket]）
- 设备 push 后，服务端通过 WebSocket 通知同账户其他在线设备
- 通知只传信号（changes_available），不传数据；数据通过 HTTPS API 拉取
- 设备上线/下线通知同账户其他设备

连接生命周期：
- 连接时验证 API Key，失败立即关闭（code 4001）
- 定时 ping/pong 保活
- 断开时从连接池移除，通知同账户其他设备
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field

from fastapi import WebSocket

logger = logging.getLogger(__name__)


@dataclass
class ConnectionInfo:
    """一条 WebSocket 连接的元信息。"""
    ws: WebSocket
    account_id: str
    device_id: str
    platform: str


class ConnectionManager:
    """WebSocket 连接池，全局单例。

    线程安全：所有操作都在 asyncio 事件循环里，不需要额外锁。

    连接数限制：
    - per-account：max_devices × 2（防单账户 FD 耗尽，在 main.py 的 WS 端点检查）
    - 全局：MAX_GLOBAL_CONNECTIONS（防多账户协同 FD 耗尽）
    """

    # 全局最大连接数（防多账户协同 FD 耗尽）
    MAX_GLOBAL_CONNECTIONS = 1000

    # ping/pong 配置（通过 set_ping_config 注入）
    _ping_interval: int = 20  # 默认 20 秒发一次 ping
    _ping_timeout: int = 60   # 默认 60 秒无 pong 视为死连接

    def __init__(self):
        # account_id → ConnectionInfo 列表
        self._connections: dict[str, list[ConnectionInfo]] = {}

    def set_ping_config(self, interval: int, timeout: int) -> None:
        """设置 ping/pong 参数（由 main.py 启动时注入 config）。"""
        self._ping_interval = interval
        self._ping_timeout = timeout

    def total_connections(self) -> int:
        """当前全局在线连接总数。"""
        return sum(len(conns) for conns in self._connections.values())

    def is_at_global_limit(self) -> bool:
        """是否已达全局连接数上限。"""
        return self.total_connections() >= self.MAX_GLOBAL_CONNECTIONS

    async def connect(
        self,
        ws: WebSocket,
        account_id: str,
        device_id: str,
        platform: str,
        subprotocol: str | None = None,
    ) -> None:
        """接受连接并注册到连接池。

        Args:
            subprotocol: 若客户端用 Sec-WebSocket-Protocol 认证，需回显该子协议以满足浏览器握手
        """
        await ws.accept(subprotocol=subprotocol)

        info = ConnectionInfo(ws=ws, account_id=account_id, device_id=device_id, platform=platform)
        self._connections.setdefault(account_id, []).append(info)

        logger.info("设备 %s (%s) 上线，账户 %s", device_id[:8] + "…", platform, account_id[:8] + "…")

        # 通知同账户其他设备：有新设备上线
        await self._broadcast(account_id, {
            "type": "device_online",
            "data": {"device_id": device_id, "platform": platform},
        }, exclude_device=device_id)

    async def disconnect(self, account_id: str, device_id: str) -> None:
        """从连接池移除、主动关闭 WebSocket、通知其他设备。

        主动 close 是必要的：仅从池中移除而不关闭 ws，
        客户端会以为连接还活着，继续等待消息。
        """
        conns = self._connections.get(account_id, [])

        # 找到要断开的连接并主动关闭
        for c in conns:
            if c.device_id == device_id:
                try:
                    # code 4002 = 服务端主动踢出
                    await c.ws.close(code=4002, reason="设备已被撤销或账户已删除")
                except Exception:
                    # 客户端可能已断开，忽略
                    pass
                break

        # 从连接池移除
        self._connections[account_id] = [
            c for c in conns if c.device_id != device_id
        ]
        if not self._connections[account_id]:
            del self._connections[account_id]

        logger.info("设备 %s 下线，账户 %s", device_id[:8] + "…", account_id[:8] + "…")

        # 通知同账户其他设备：有设备下线
        await self._broadcast(account_id, {
            "type": "device_offline",
            "data": {"device_id": device_id},
        })

    async def notify_changes(self, account_id: str, source_device_id: str) -> None:
        """通知同账户其他在线设备：有新变更可拉取。

        Push 操作完成后调用此方法。
        """
        await self._broadcast(account_id, {
            "type": "changes_available",
            "data": {"source_device_id": source_device_id},
        }, exclude_device=source_device_id)

    async def _broadcast(
        self,
        account_id: str,
        message: dict,
        exclude_device: str | None = None,
    ) -> None:
        """向同账户所有在线设备广播消息（可排除某个设备）。"""
        conns = self._connections.get(account_id, [])
        if not conns:
            return

        message_str = json.dumps(message)
        dead: list[ConnectionInfo] = []

        for conn in conns:
            if exclude_device and conn.device_id == exclude_device:
                continue
            try:
                await conn.ws.send_text(message_str)
            except Exception:
                logger.warning("发送 WebSocket 消息失败，设备 %s", conn.device_id[:8] + "…")
                dead.append(conn)

        # 清理断开的连接
        for conn in dead:
            await self._remove_connection(conn)

    async def _remove_connection(self, info: ConnectionInfo) -> None:
        conns = self._connections.get(info.account_id, [])
        if info in conns:
            conns.remove(info)
        if not conns and info.account_id in self._connections:
            del self._connections[info.account_id]

    def get_online_devices(self, account_id: str) -> list[str]:
        """获取账户当前在线设备 ID 列表。"""
        return [c.device_id for c in self._connections.get(account_id, [])]
