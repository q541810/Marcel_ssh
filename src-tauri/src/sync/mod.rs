//! 跨设备同步模块。
//!
//! 模块组织：
//! - `crypto`：E2E 加密核心（HKDF / AES-GCM / Sync Key 生成）
//! - `config_code`：配置码生成与验证
//! - `keychain`：Sync Key 在设备 keychain 的存储
//! - `profile`：sync_profile 管理 + 平台过滤
//! - `client`：HTTP 客户端
//! - `ws_client`：WebSocket（changes_available → 触发 pull）
//! - `engine`：diff 计算 / push / pull / 三方合并
//! - `merge`：三方合并算法（base/ours/theirs）
//! - `scheduler`：防抖 / 启动拉取 / 轮询 / WS
//! - `accessor`：连接 SyncEngine 与各 store 的桥梁（读/写真实配置值）
//! - `settings_field`：settings 字段级同步支持（字段路径读写）

pub mod accessor;
pub mod client;
pub mod config_code;
pub mod crypto;
pub mod engine;
pub mod keychain;
pub mod merge;
pub mod profile;
pub mod scheduler;
pub mod settings_field;
pub mod ws_client;
