"""账户认证与 API Key 管理。

信任模型：
- 配置码（32位随机字符串）是账户根信任锚，用户手抄保存，服务端只存 SHA-256(配置码) = account_id
- Sync Key（256位随机）是真正加密数据的密钥，用配置码派生的包装密钥加密后存服务端
- API Key 是设备级 bearer token，每个设备独立，服务端存 SHA-256(api_key)
- 配置码不在服务端存储（只存哈希），不可恢复，丢失即账户不可重建

安全：
- API Key 用 secrets.token_urlsafe(32) 生成（256位熵）
- 所有哈希用 SHA-256，hex digest
- 配置码 hash 和 API Key hash 都是不可逆的，服务端无法反推原文

威胁模型边界（诚实声明，文档/宣传不得超出）：
1. 机密性完全依赖配置码原文：不知道配置码就派生不出包装密钥，
   拿到 encrypted_sync_key 也解不开 Sync Key，密文不可读。
2. config_code_hash（= account_id）本身是明文存储的 bearer 值：
   仅凭它即可调 /api/account/join 注册设备换取 API Key，进而推送垃圾密文、
   删 key、删设备、删整个账户。即：hash 泄露 = 账户完整性/可用性沦陷，
   但机密性不破。因此任何组件（日志、admin 面板、错误信息）都不得
   向非必要位置暴露完整 account_id。
3. 服务端是半可信的：版本号明文由服务端比较（LWW 需要），AES-GCM 保证
   机密性与单条完整性，但不保证新鲜度——持凭证者或服务端本身可将旧密文
   配更高版本重放/回滚。客户端接受此边界（E2E 加密的目标是防窃读，非防篡改序）。
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timezone

import aiosqlite
from db import Database


def sha256_hex(value: str) -> str:
    """SHA-256 哈希，返回 hex digest。"""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def generate_api_key() -> str:
    """生成 256 位熵的 API Key（URL-safe base64，约 43 字符）。"""
    return secrets.token_urlsafe(32)


def now_iso() -> str:
    """当前 UTC 时间 ISO 格式。"""
    return datetime.now(timezone.utc).isoformat()


class AuthManager:
    """账户与认证管理。"""

    def __init__(self, db: Database):
        self._db = db

    async def account_exists(self, account_id: str) -> bool:
        """检查账户是否已存在（account_id = SHA-256(配置码)）。"""
        row = await self._db.fetchone(
            "SELECT 1 FROM accounts WHERE id = ?",
            (account_id,),
        )
        return row is not None

    async def get_encrypted_sync_key(self, account_id: str) -> str | None:
        """获取账户的加密 Sync Key（用于后续设备 join）。"""
        row = await self._db.fetchone(
            "SELECT encrypted_sync_key FROM accounts WHERE id = ?",
            (account_id,),
        )
        return row["encrypted_sync_key"] if row else None

    async def setup_account(
        self,
        config_code_hash: str,
        api_key_hash: str,
        encrypted_sync_key: str,
        device_id: str,
        platform: str,
        sync_profile: dict,
        app_version: str | None = None,
    ) -> None:
        """第一台设备注册账户 + 注册设备。事务性操作。

        并发安全：在 _db._lock 内 INSERT，依赖 PRIMARY KEY 约束做最终防线。
        若两个并发请求都通过预检查，第二个 INSERT 会触发 IntegrityError，
        在此捕获并转为 ValueError（与预检查语义一致）。

        Raises:
            ValueError: 账户已存在（预检查或并发竞态）
        """
        # 预检查（快速失败，避免无谓的锁竞争）
        if await self.account_exists(config_code_hash):
            raise ValueError("账户已存在")

        import json
        now = now_iso()

        async with self._db._lock:
            conn = self._db.conn
            try:
                await conn.execute(
                    "INSERT INTO accounts (id, encrypted_sync_key, created_at) VALUES (?, ?, ?)",
                    (config_code_hash, encrypted_sync_key, now),
                )
                await conn.execute(
                    """INSERT INTO devices (id, account_id, platform, sync_profile, api_key_hash, last_seen_at, app_version)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (device_id, config_code_hash, platform, json.dumps(sync_profile), api_key_hash, now, app_version),
                )
                await conn.commit()
            except aiosqlite.IntegrityError:
                # 并发竞态：两个请求同时通过预检查，第二个触发 PRIMARY KEY 冲突
                # 回滚已执行的语句（accounts INSERT 已执行但未 commit）
                await conn.rollback()
                raise ValueError("账户已存在")

    async def delete_account(self, config_code_hash: str) -> bool:
        """删除账户及所有关联数据（账户重置）。

        Returns:
            True 如果删除成功，False 如果账户不存在
        """
        if not await self.account_exists(config_code_hash):
            return False

        async with self._db._lock:
            conn = self._db.conn
            # 外键级联会自动删除 devices 和 sync_snapshots
            await conn.execute("DELETE FROM accounts WHERE id = ?", (config_code_hash,))
            await conn.commit()
        return True

    async def cleanup_empty_accounts(self) -> int:
        """删除设备数为 0 的账户（含级联数据）。

        用于每日定时维护：所有设备都被移除后，账户本身（含 sync_snapshots）
        已无意义，清理以释放空间。

        Returns:
            被删除的账户数
        """
        # 删除 devices 表中没有任何设备记录的账户。外键级联会自动清理 sync_snapshots。
        async with self._db._lock:
            conn = self._db.conn
            cursor = await conn.execute(
                """DELETE FROM accounts
                   WHERE id NOT IN (SELECT DISTINCT account_id FROM devices
                                    WHERE account_id IS NOT NULL)"""
            )
            await conn.commit()
            return cursor.rowcount

    async def verify_api_key(
        self,
        api_key: str,
        app_version: str | None = None,
    ) -> tuple[str, str] | None:
        """验证 API Key，返回 (account_id, device_id) 或 None。

        服务端只存 SHA-256(api_key)，验证时比对哈希。
        同时更新设备 last_seen_at 与 app_version（客户端通过 X-App-Version
        header 上报；旧客户端不带该 header，传 None 时保留库中已有值）。
        """
        api_key_hash = sha256_hex(api_key)
        row = await self._db.fetchone(
            "SELECT account_id, id as device_id FROM devices WHERE api_key_hash = ?",
            (api_key_hash,),
        )
        if row is None:
            return None

        # 更新最后活跃时间 + 客户端版本（None = 旧客户端未上报，保留原值）
        await self._db.execute(
            "UPDATE devices SET last_seen_at = ?, app_version = COALESCE(?, app_version) WHERE id = ?",
            (now_iso(), app_version, row["device_id"]),
        )
        return row["account_id"], row["device_id"]
