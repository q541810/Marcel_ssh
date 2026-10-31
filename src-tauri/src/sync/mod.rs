//! 跨设备同步。
//!
//! 总原则：**存储端只会存取文件，所有判断都在客户端**；每台设备只往自己的目录写，
//! 永不两台设备写同一个文件，所以存储端不需要锁和版本比较。
//!
//! 子模块：
//! - [`core`]：核心库（纯逻辑，没有网络 / 文件 IO）——混合时钟、JSON ↔ 叶子的扁平化、
//!   镜像（按叶子的 LWW 合并）、本机改动捕获 `diff`、远端改动落地 `apply_to_doc`、
//!   作用域规则、加密与远端文件格式。整个同步的正确性地基，宁可多写测试。
//! - [`storage`]：存储适配器（WebDAV / SFTP / 内存测试替身），统一成 [`storage::SyncStorage`]。
//! - 运行时（manager）：
//!   - [`manager`]：`SyncManager`——actor + 定时器 + 命令，挂在 `AppState.sync`；
//!   - [`engine`]：一轮同步（捕获 → 上传 → 拉取 → 落地 → 压缩）与开启 / 加入 / 停止；
//!   - [`ledger`]：账本的纯逻辑部分（镜像 / 基线 / 待上传队列 / 大量删除闸 / 吸收远端文件）；
//!   - [`store`]：账本落盘（`<配置目录>/sync/`，登记表里的 `DataSourceId::SyncState`）；
//!   - [`sources`] / [`scopes`]：六个同步源的适配与作用域规则；
//!   - [`history`]：同步记录（人话说明 + 撤销）；
//!   - [`join`]：加入同步时的连接去重；
//!   - [`secrets`] / [`backends`]：机密与存储后端的注入口（测试替身）。
//!
//! 数据流与「为什么先捕获再落地」见 [`engine`] 的模块文档。

pub mod backends;
pub mod core;
pub mod docedit;
pub mod engine;
pub mod history;
pub mod join;
pub mod ledger;
pub mod manager;
pub mod rows;
pub mod scopes;
pub mod secrets;
pub mod sources;
pub mod storage;
pub mod store;
pub mod streams;
pub mod types;

#[cfg(test)]
mod scope_guard;
#[cfg(test)]
mod tests;

pub use manager::{SyncManager, SyncWiring};
pub use streams::StreamProgress;
pub use types::{
    SecretGroupEstimate, SyncCreateResult, SyncDataApplied, SyncDevice, SyncHistoryEntry,
    SyncState, SyncStatus, TierEstimate,
};
