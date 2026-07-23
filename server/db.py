"""SQLite 数据库管理。

使用 aiosqlite 异步访问，单连接 + asyncio.Lock 串行化写入（与客户端 ConversationDb 模式一致）。
schema 用 CREATE TABLE IF NOT EXISTS 幂等建表，后续增量迁移用 ALTER TABLE ADD COLUMN。
"""

from __future__ import annotations

import asyncio
import os
from typing import Any

import aiosqlite


# 所有建表语句，启动时幂等执行
SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    encrypted_sync_key TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    sync_profile TEXT NOT NULL DEFAULT '{}',
    api_key_hash TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_snapshots (
    account_id TEXT NOT NULL,
    item_key TEXT NOT NULL,
    version INTEGER NOT NULL,
    encrypted_value TEXT,
    updated_device_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, item_key)
);

CREATE INDEX IF NOT EXISTS idx_sync_snapshots_account ON sync_snapshots(account_id);
CREATE INDEX IF NOT EXISTS idx_devices_account ON devices(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_api_key_hash ON devices(api_key_hash);
"""


class Database:
    """异步 SQLite 封装，全局单例。"""

    def __init__(self, db_path: str):
        self._db_path = db_path
        self._conn: aiosqlite.Connection | None = None
        self._lock: asyncio.Lock | None = None

    async def init(self) -> None:
        """初始化数据库连接和 schema。应在应用启动时调用。"""
        # 确保数据目录存在
        db_dir = os.path.dirname(self._db_path)
        if db_dir:
            os.makedirs(db_dir, exist_ok=True)

        self._lock = asyncio.Lock()
        self._conn = await aiosqlite.connect(self._db_path)
        self._conn.row_factory = aiosqlite.Row

        # 启用外键约束（SQLite 默认关闭）
        await self._conn.execute("PRAGMA foreign_keys = ON")
        # WAL 模式提升并发读写性能
        await self._conn.execute("PRAGMA journal_mode = WAL")

        await self._conn.executescript(SCHEMA_SQL)
        await self._conn.commit()

    async def close(self) -> None:
        if self._conn:
            await self._conn.close()
            self._conn = None

    @property
    def conn(self) -> aiosqlite.Connection:
        if self._conn is None:
            raise RuntimeError("Database not initialized, call init() first")
        return self._conn

    async def execute(self, sql: str, params: tuple[Any, ...] = ()) -> aiosqlite.Cursor:
        async with self._lock:
            cursor = await self.conn.execute(sql, params)
            await self.conn.commit()
            return cursor

    async def execute_many(self, sql: str, params_seq: list[tuple[Any, ...]]) -> None:
        async with self._lock:
            await self.conn.executemany(sql, params_seq)
            await self.conn.commit()

    async def fetchone(self, sql: str, params: tuple[Any, ...] = ()) -> aiosqlite.Row | None:
        async with self._lock:
            cursor = await self.conn.execute(sql, params)
            return await cursor.fetchone()

    async def fetchall(self, sql: str, params: tuple[Any, ...] = ()) -> list[aiosqlite.Row]:
        async with self._lock:
            cursor = await self.conn.execute(sql, params)
            return await cursor.fetchall()
