"""设备管理：注册、查询、sync_profile 更新。

每个设备属于一个账户，有独立的 API Key。
sync_profile 是用户选择的同步项，per-device 存储。
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

import aiosqlite
from auth import AuthManager, generate_api_key, sha256_hex, now_iso
from db import Database
from models import (
    DeviceRegisterRequest,
    DeviceRegisterResponse,
    SyncProfileUpdateRequest,
    DeviceInfoResponse,
)

if TYPE_CHECKING:
    from sync import SyncEngine


class DeviceManager:
    """设备注册与 sync_profile 管理。"""

    def __init__(self, db: Database, auth: AuthManager, sync_engine: SyncEngine | None = None):
        self._db = db
        self._auth = auth
        self._sync_engine = sync_engine

    async def count_devices(self, account_id: str) -> int:
        row = await self._db.fetchone(
            "SELECT COUNT(*) as cnt FROM devices WHERE account_id = ?",
            (account_id,),
        )
        return row["cnt"] if row else 0

    async def register_device(
        self,
        account_id: str,
        request: DeviceRegisterRequest,
    ) -> DeviceRegisterResponse:
        """为新设备生成 API Key 并注册。

        Raises:
            ValueError: 设备数超限或设备 ID 已存在
        """
        # 检查设备数限制
        count = await self.count_devices(account_id)
        if count >= self._max_devices:
            raise ValueError(f"设备数已达上限（{self._max_devices}）")

        # 检查设备 ID 是否已注册
        existing = await self._db.fetchone(
            "SELECT 1 FROM devices WHERE id = ?",
            (request.device_id,),
        )
        if existing:
            raise ValueError("设备 ID 已存在")

        api_key = generate_api_key()
        api_key_hash = sha256_hex(api_key)
        now = now_iso()

        try:
            await self._db.execute(
                """INSERT INTO devices (id, account_id, platform, sync_profile, api_key_hash, last_seen_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    request.device_id,
                    account_id,
                    request.platform,
                    json.dumps(request.sync_profile),
                    api_key_hash,
                    now,
                ),
            )
        except aiosqlite.IntegrityError as e:
            # FK 约束失败：account_id 不存在（verify_auth 后到 register_device 之间账户被并发删除）
            # PK 冲突：设备 ID 已存在（前面预检查后到 INSERT 之间并发注册）
            # api_key_hash 唯一约束冲突：理论上不可能（secrets.token_urlsafe(32) 碰撞概率 2^-256）
            # 三者都返回 400 而非 500
            err_msg = str(e).upper()
            if "FOREIGN KEY" in err_msg or "ACCOUNTS" in err_msg:
                raise ValueError("账户不存在（可能已被删除）")
            if "API_KEY_HASH" in err_msg:
                raise ValueError("API Key 生成冲突，请重试")
            raise ValueError("设备 ID 已存在")

        return DeviceRegisterResponse(device_id=request.device_id, api_key=api_key)

    async def update_sync_profile(
        self,
        account_id: str,
        request: SyncProfileUpdateRequest,
    ) -> None:
        """更新设备的 sync_profile。托管模式下检查配额。"""
        new_json = json.dumps(request.sync_profile)

        if self._sync_engine is not None:
            await self._sync_engine.check_sync_profile_quota(account_id, request.device_id, new_json)

        result = await self._db.execute(
            "UPDATE devices SET sync_profile = ? WHERE id = ? AND account_id = ?",
            (new_json, request.device_id, account_id),
        )
        if result.rowcount == 0:
            raise ValueError("设备不存在或不属于该账户")

    async def get_devices(self, account_id: str) -> list[DeviceInfoResponse]:
        rows = await self._db.fetchall(
            "SELECT id, platform, sync_profile, last_seen_at FROM devices WHERE account_id = ?",
            (account_id,),
        )
        return [
            DeviceInfoResponse(
                device_id=row["id"],
                platform=row["platform"],
                sync_profile=json.loads(row["sync_profile"]),
                last_seen_at=row["last_seen_at"],
            )
            for row in rows
        ]

    async def get_sync_profile(self, device_id: str) -> dict | None:
        """获取设备的 sync_profile。"""
        row = await self._db.fetchone(
            "SELECT sync_profile FROM devices WHERE id = ?",
            (device_id,),
        )
        if row is None:
            return None
        return json.loads(row["sync_profile"])

    async def delete_device(self, account_id: str, device_id: str) -> bool:
        """删除设备（撤销 API Key）。"""
        result = await self._db.execute(
            "DELETE FROM devices WHERE id = ? AND account_id = ?",
            (device_id, account_id),
        )
        return result.rowcount > 0

    def set_max_devices(self, max_devices: int) -> None:
        self._max_devices = max_devices

    _max_devices = 100
