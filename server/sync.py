"""同步引擎：push / pull / snapshot。

per-key 版本号 LWW（Last-Write-Wins）：
- 每个 item_key 有独立的递增版本号
- push 时，服务端比较版本号：version > 当前版本 才接受
- 版本号是明文（服务端需要读取做比较），不含敏感信息
- encrypted_value 为 null 表示删除该 key

配额管理（托管模式）：
- 每账户总存储字节数不超过 [server].account_quota_bytes
- 包含 sync_snapshots.encrypted_value + 所有 devices.sync_profile
- 自部署模式 quota=0 表示无限制
"""

from __future__ import annotations

import json

from db import Database
from models import (
    PushRequest,
    PushResponse,
    PushAcceptedItem,
    PushRejectedItem,
    PullRequest,
    PullResponse,
    SnapshotResponse,
    SyncItem,
)
from auth import now_iso


class SyncEngine:
    """同步核心逻辑。"""

    def __init__(self, db: Database):
        self._db = db

    async def push(
        self,
        account_id: str,
        device_id: str,
        request: PushRequest,
    ) -> PushResponse:
        """处理 push：per-key 版本号比较，接受或拒绝。

        规则：
        - version > 服务端当前版本 → 接受，更新快照
        - version <= 服务端当前版本 → 拒绝（reason: outdated_version）
        - encrypted_value 为 null → 删除该 key（仍需版本号更高）

        并发安全：配额检查在 _db._lock 内执行，避免条件竞争
        （原实现 _get_account_size 在锁外，两个并发 push 可都通过检查后双双写入，实际超配额）
        """
        accepted: list[PushAcceptedItem] = []
        rejected: list[PushRejectedItem] = []

        # 预计算 push 字节数（不依赖数据库，锁外即可）
        push_size = sum(
            len(item.encrypted_value.encode("utf-8")) if item.encrypted_value else 0
            for item in request.changes
        )

        now = now_iso()

        async with self._db._lock:
            conn = self._db.conn

            # 配额检查（托管模式）— 必须在锁内执行，避免并发 push 竞争
            if self._quota_bytes > 0:
                current_size = await self._get_account_size_locked(conn, account_id)
                if current_size + push_size > self._quota_bytes:
                    raise QuotaExceededError(current_size, push_size, self._quota_bytes)

            for item in request.changes:
                # 查询当前版本
                cursor = await conn.execute(
                    "SELECT version FROM sync_snapshots WHERE account_id = ? AND item_key = ?",
                    (account_id, item.key),
                )
                rows = await cursor.fetchall()
                current_version = rows[0]["version"] if rows else 0

                if item.version <= current_version:
                    rejected.append(PushRejectedItem(
                        key=item.key,
                        version=item.version,
                        reason="outdated_version",
                    ))
                    continue

                # upsert 快照
                await conn.execute(
                    """INSERT INTO sync_snapshots (account_id, item_key, version, encrypted_value, updated_device_id, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?)
                       ON CONFLICT(account_id, item_key) DO UPDATE SET
                           version = excluded.version,
                           encrypted_value = excluded.encrypted_value,
                           updated_device_id = excluded.updated_device_id,
                           updated_at = excluded.updated_at""",
                    (account_id, item.key, item.version, item.encrypted_value, device_id, now),
                )
                accepted.append(PushAcceptedItem(key=item.key, version=item.version))

            await conn.commit()

        return PushResponse(accepted=accepted, rejected=rejected)

    async def pull(
        self,
        account_id: str,
        request: PullRequest,
    ) -> PullResponse:
        """增量拉取：返回 version > 客户端持有版本的所有项。"""
        rows = await self._db.fetchall(
            "SELECT item_key, version, encrypted_value FROM sync_snapshots WHERE account_id = ?",
            (account_id,),
        )

        items: list[SyncItem] = []
        latest_versions: dict[str, int] = {}

        for row in rows:
            key = row["item_key"]
            version = row["version"]
            latest_versions[key] = version

            client_version = request.last_sync_versions.get(key, 0)
            if version > client_version:
                items.append(SyncItem(
                    key=key,
                    version=version,
                    encrypted_value=row["encrypted_value"],
                ))

        return PullResponse(items=items, latest_versions=latest_versions)

    async def snapshot(self, account_id: str) -> SnapshotResponse:
        """全量快照拉取（新设备首次同步用）。"""
        rows = await self._db.fetchall(
            "SELECT item_key, version, encrypted_value FROM sync_snapshots WHERE account_id = ?",
            (account_id,),
        )

        items = [
            SyncItem(
                key=row["item_key"],
                version=row["version"],
                encrypted_value=row["encrypted_value"],
            )
            for row in rows
        ]

        total_size = sum(
            len(row["encrypted_value"].encode("utf-8")) if row["encrypted_value"] else 0
            for row in rows
        )

        return SnapshotResponse(items=items, total_size=total_size)

    async def _get_account_size_locked(self, conn, account_id: str) -> int:
        """计算账户当前存储总字节数（锁内，含 snapshots + sync_profiles）。"""
        cursor = await conn.execute(
            "SELECT COALESCE(SUM(LENGTH(encrypted_value)), 0) as total FROM sync_snapshots WHERE account_id = ?",
            (account_id,),
        )
        rows = await cursor.fetchall()
        snapshots = rows[0]["total"] if rows else 0

        cursor2 = await conn.execute(
            "SELECT COALESCE(SUM(LENGTH(sync_profile)), 0) as total FROM devices WHERE account_id = ?",
            (account_id,),
        )
        rows2 = await cursor2.fetchall()
        profiles = rows2[0]["total"] if rows2 else 0

        return snapshots + profiles

    async def check_sync_profile_quota(
        self,
        account_id: str,
        device_id: str,
        new_sync_profile_json: str,
    ) -> None:
        """检查更新 sync_profile 后是否超出配额。不超则无操作；超则抛 QuotaExceededError。"""
        if self._quota_bytes <= 0:
            return

        new_size = len(new_sync_profile_json.encode("utf-8"))
        if new_size > self._quota_bytes:
            raise QuotaExceededError(0, new_size, self._quota_bytes)

        async with self._db._lock:
            conn = self._db.conn
            cursor = await conn.execute(
                "SELECT LENGTH(sync_profile) as size FROM devices WHERE id = ? AND account_id = ?",
                (device_id, account_id),
            )
            row = await cursor.fetchone()
            old_size = row["size"] if row else 0

            delta = new_size - old_size
            if delta <= 0:
                return

            current_total = await self._get_account_size_locked(conn, account_id)
            if current_total + delta > self._quota_bytes:
                raise QuotaExceededError(current_total, delta, self._quota_bytes)

    def set_quota(self, quota_bytes: int) -> None:
        self._quota_bytes = quota_bytes

    _quota_bytes = 0


class QuotaExceededError(Exception):
    """配额超限异常。"""

    def __init__(self, current: int, push_size: int, quota: int):
        self.current = current
        self.push_size = push_size
        self.quota = quota
        super().__init__(f"配额超限：当前 {current} 字节 + 推送 {push_size} 字节 > 配额 {quota} 字节")
