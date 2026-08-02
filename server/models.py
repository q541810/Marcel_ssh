"""Pydantic 请求/响应模型。

命名约定：请求模型后缀 Request，响应模型后缀 Response。
所有字段使用 snake_case，FastAPI 自动处理 JSON 的 camelCase 转换由前端负责。
"""

from __future__ import annotations

from typing import Literal, Optional
from pydantic import BaseModel, Field

# ── 格式约束正则 ──────────────────────────────────────
# config_code_hash = SHA-256 hex（客户端 src-tauri/src/sync/crypto.rs:225 生成）
_CONFIG_CODE_HASH_PATTERN = r"^[0-9a-f]{64}$"
# device_id = UUID v4（客户端 src-tauri/src/commands/sync.rs:133 Uuid::new_v4().to_string()）
_DEVICE_ID_PATTERN = r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"


# ── 账户 ──────────────────────────────────────────────

class AccountSetupRequest(BaseModel):
    """第一台设备注册账户。"""
    config_code_hash: str = Field(..., pattern=_CONFIG_CODE_HASH_PATTERN, description="SHA-256(配置码)，作为 account_id")
    encrypted_sync_key: str = Field(..., max_length=256, description="用配置码派生密钥包装后的 Sync Key（base64）")
    device_id: str = Field(..., pattern=_DEVICE_ID_PATTERN, description="客户端生成的设备 UUID")
    platform: Literal["desktop", "mobile"] = Field(..., description="desktop / mobile")
    sync_profile: dict = Field(default_factory=dict, description="用户选择的同步项")


class AccountJoinRequest(BaseModel):
    """后续设备加入已有账户，并在同一次请求中注册本设备。

    必须在 join 内完成设备注册并返回 api_key——否则无法调用需 Bearer
    认证的 /api/device/register（鸡生蛋）。
    """
    config_code_hash: str = Field(..., pattern=_CONFIG_CODE_HASH_PATTERN, description="SHA-256(配置码)")
    device_id: str = Field(..., pattern=_DEVICE_ID_PATTERN, description="客户端生成的设备 UUID")
    platform: Literal["desktop", "mobile"] = Field(..., description="desktop / mobile")
    sync_profile: dict = Field(default_factory=dict, description="用户选择的同步项")


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


class DeviceRegisterResponse(BaseModel):
    device_id: str
    api_key: str = Field(..., description="明文 API Key，仅此一次返回")


class SyncProfileUpdateRequest(BaseModel):
    device_id: str = Field(..., pattern=_DEVICE_ID_PATTERN)
    sync_profile: dict


class DeviceInfoResponse(BaseModel):
    device_id: str
    platform: str
    sync_profile: dict
    last_seen_at: str


# ── 同步 ──────────────────────────────────────────────

class SyncItem(BaseModel):
    """单个同步项。"""
    key: str = Field(..., max_length=256, description="扁平化 key，如 settings.fontSize / connections.{id}")
    version: int = Field(..., description="递增版本号")
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


class SnapshotResponse(BaseModel):
    """全量快照拉取。"""
    items: list[SyncItem]
    total_size: int = Field(..., description="总字节数，用于配额展示")


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
