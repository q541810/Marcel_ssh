"""Pydantic 请求/响应模型。

命名约定：请求模型后缀 Request，响应模型后缀 Response。
所有字段使用 snake_case，FastAPI 自动处理 JSON 的 camelCase 转换由前端负责。
"""

from __future__ import annotations

import json
from typing import Literal, Optional
from pydantic import BaseModel, Field, field_validator

# ── 格式约束正则 ──────────────────────────────────────
# config_code_hash = SHA-256 hex（客户端 src-tauri/src/sync/crypto.rs:225 生成）
_CONFIG_CODE_HASH_PATTERN = r"^[0-9a-f]{64}$"
# device_id = UUID v4（客户端 src-tauri/src/commands/sync.rs:133 Uuid::new_v4().to_string()）
_DEVICE_ID_PATTERN = r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"

# sync_profile 序列化后最大字节数（256KB）。
# sync_profile 只是 per-device 同步偏好（分类开关 + excluded_keys 集合，
# 见客户端 src-tauri/src/sync/profile.rs SyncProfile），正常几百字节；
# 极端手动排除上千 key 也就 ~30KB，256KB ≈ 5000 条排除项，合法场景到不了。
# 聊天/连接等实际数据走 SyncItem.encrypted_value（单条 2MB），不受此限制。
# 目的：阻止恶意注册往 setup/join/register 塞近 20MB profile 的存储 DoS。
_SYNC_PROFILE_MAX_BYTES = 256 * 1024

# version 上界：2^53（远离 SQLite i64 边界，客户端 max+1 不会溢出；
# 合法版本号逐次 +1 递增，正常使用永远到不了）
_VERSION_MAX = 2**53


def _validate_sync_profile_size(v: dict) -> dict:
    """校验 sync_profile 序列化后大小，超限抛 ValueError（pydantic → 422）。"""
    size = len(json.dumps(v, ensure_ascii=False).encode("utf-8"))
    if size > _SYNC_PROFILE_MAX_BYTES:
        raise ValueError(
            f"sync_profile 过大：{size} 字节 > 上限 {_SYNC_PROFILE_MAX_BYTES} 字节"
        )
    return v


# ── 账户 ──────────────────────────────────────────────

class AccountSetupRequest(BaseModel):
    """第一台设备注册账户。"""
    config_code_hash: str = Field(..., pattern=_CONFIG_CODE_HASH_PATTERN, description="SHA-256(配置码)，作为 account_id")
    encrypted_sync_key: str = Field(..., max_length=256, description="用配置码派生密钥包装后的 Sync Key（base64）")
    device_id: str = Field(..., pattern=_DEVICE_ID_PATTERN, description="客户端生成的设备 UUID")
    platform: Literal["desktop", "mobile"] = Field(..., description="desktop / mobile")
    sync_profile: dict = Field(default_factory=dict, description="用户选择的同步项")

    _check_profile_size = field_validator("sync_profile")(_validate_sync_profile_size)


class AccountJoinRequest(BaseModel):
    """后续设备加入已有账户，并在同一次请求中注册本设备。

    必须在 join 内完成设备注册并返回 api_key——否则无法调用需 Bearer
    认证的 /api/device/register（鸡生蛋）。
    """
    config_code_hash: str = Field(..., pattern=_CONFIG_CODE_HASH_PATTERN, description="SHA-256(配置码)")
    device_id: str = Field(..., pattern=_DEVICE_ID_PATTERN, description="客户端生成的设备 UUID")
    platform: Literal["desktop", "mobile"] = Field(..., description="desktop / mobile")
    sync_profile: dict = Field(default_factory=dict, description="用户选择的同步项")

    _check_profile_size = field_validator("sync_profile")(_validate_sync_profile_size)


class AccountSetupResponse(BaseModel):
    account_id: str
    device_id: str
    api_key: str = Field(..., description="明文 API Key，仅此一次返回")


class AccountJoinResponse(BaseModel):
    account_id: str
    encrypted_sync_key: str
    device_id: str
    api_key: str = Field(..., description="明文 API Key，仅此一次返回")


class AccountDeleteRequest(BaseModel):
    """账户重置：删除账户及所有数据。"""
    config_code_hash: str = Field(..., pattern=_CONFIG_CODE_HASH_PATTERN, description="SHA-256(配置码)，验证身份")


# ── 设备 ──────────────────────────────────────────────

class DeviceRegisterRequest(BaseModel):
    """后续设备注册（join 之后调用）。"""
    device_id: str = Field(..., pattern=_DEVICE_ID_PATTERN)
    platform: Literal["desktop", "mobile"]
    sync_profile: dict = Field(default_factory=dict)

    _check_profile_size = field_validator("sync_profile")(_validate_sync_profile_size)


class DeviceRegisterResponse(BaseModel):
    device_id: str
    api_key: str = Field(..., description="明文 API Key，仅此一次返回")


class SyncProfileUpdateRequest(BaseModel):
    device_id: str = Field(..., pattern=_DEVICE_ID_PATTERN)
    sync_profile: dict

    _check_profile_size = field_validator("sync_profile")(_validate_sync_profile_size)


class DeviceInfoResponse(BaseModel):
    device_id: str
    platform: str
    sync_profile: dict
    last_seen_at: str
    # 客户端版本号（X-App-Version header 上报）；旧客户端未上报为 null
    app_version: str | None = None


# ── 同步 ──────────────────────────────────────────────

class SyncItem(BaseModel):
    """单个同步项。"""
    key: str = Field(..., max_length=256, description="扁平化 key，如 settings.fontSize / connections.{id}")
    # 上界 2^53：防超大 version 写 SQLite i64 溢出 500 / 客户端 max+1 回绕（版本投毒）
    version: int = Field(..., ge=0, le=_VERSION_MAX, description="递增版本号")
    # base64(AES-GCM(JSON))，单条最大 2MB（足够装下整个会话历史）
    encrypted_value: Optional[str] = Field(None, max_length=2_000_000, description="E2E 加密后的值（base64）；null = 删除")


class PushRequest(BaseModel):
    # 单次 push 最多 1000 条变更（覆盖 6 类资源全量更新场景）
    changes: list[SyncItem] = Field(..., max_length=1000)


class PushAcceptedItem(BaseModel):
    key: str
    version: int


class PushRejectedItem(BaseModel):
    key: str
    version: int
    reason: str


class PushResponse(BaseModel):
    accepted: list[PushAcceptedItem]
    rejected: list[PushRejectedItem]


class PullRequest(BaseModel):
    """增量拉取：只返回 version > 客户端持有版本的项。"""
    # max_length 限制 key 数量，防止超大 dict 导致 OOM（20MB JSON 可解析出百万级 key）
    last_sync_versions: dict[str, int] = Field(default_factory=dict, max_length=10000)


class PullResponse(BaseModel):
    items: list[SyncItem]
    latest_versions: dict[str, int] = Field(..., description="每个 key 的当前版本号")
    # 账户内所有设备已上报的最高客户端版本号（版本闸门：客户端据此暂停同步）
    # 旧服务端 / 账户内全部为未上报版本的设备时为 null
    max_app_version: str | None = Field(None, description="账户内设备已上报的最高客户端版本号")


class SnapshotResponse(BaseModel):
    """全量快照拉取。"""
    items: list[SyncItem]
    total_size: int = Field(..., description="总字节数，用于配额展示")
    max_app_version: str | None = Field(None, description="账户内设备已上报的最高客户端版本号")


class AccountQuotaResponse(BaseModel):
    """账户配额使用情况（GET /api/account/quota）。"""
    quota_used_bytes: int = Field(..., description="已用字节数（snapshots + sync_profiles）")
    quota_limit_bytes: int = Field(..., description="配额上限字节数；0=无限制")
    mode: str = Field(..., description="hosted / self-hosted")


# ── WebSocket ────────────────────────────────────────

class WSMessage(BaseModel):
    """服务端 → 客户端的 WebSocket 消息。"""
    type: str = Field(..., description="changes_available / device_online / device_offline")
    data: dict = Field(default_factory=dict)
