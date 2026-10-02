//! 无感更新器（桌面 Windows + Android）。
//!
//! 流程：后台定时检查（启动 30 秒后首查，之后每 4 小时）→ 发现新版本且
//! 「自动下载并安装更新」开启时，静默下载安装包到缓存目录 →
//! sha256 校验（Windows 另加 minisign 验签）→ 就绪待装。
//!
//! 安装动作两端不同，由平台能力决定（实现见 `install.rs`）：
//! - **Windows（NSIS）**：安装只发生在应用退出之后 —— 退出钩子延迟约 2 秒
//!   静默运行安装器（`/S` 静默、`/UPDATE` 更新模式、`/R` 装完自动启动应用），
//!   因此用户正常关闭应用后下次打开即新版本；「立即安装」也走同一退出路径。
//! - **Android（APK）**：系统不允许普通应用静默安装，安装必须由用户在系统
//!   安装器界面确认；因此就绪后是「一键安装」——把 content:// URI 交给系统
//!   安装器，签名一致性与版本递增由系统强制校验。安装结果通过下次启动的
//!   版本比对判定（`cleanup_update_dir` 见到 `version <= current` 即认定已装成功）。
//! - **其他桌面平台（macOS/Linux）**：只检查并提示，下载/安装入口由
//!   `update_capabilities` 关掉，UI 不会出现点了必然失败的按钮。
//!
//! 原则：绝不自动重启、绝不打断 Agent 任务 / SSH 会话；更新相关文件
//! 全部集中在缓存目录 `update/` 下并由启动清理兜底（半成品删除、已装
//! 完成的包删除、上次没装上的包重新校验后自动续装），用户永远不需要
//! 手动清理。Android 侧该目录位于应用私有 cacheDir 内，已被 FileProvider
//! （`cache-path "."`）覆盖，可直接把 content:// URI 交给系统安装器。

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

// base64 只用于解码 Windows 的 minisign 公钥/签名文本。
#[cfg(windows)]
use base64::Engine;
use futures::FutureExt as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::update::{check_for_update, LatestRelease};
use crate::config::settings::UpdateMode;
use crate::error::AppError;

pub mod install;

/// 更新签名公钥：minisign 公钥文件整体 base64（`pnpm tauri signer generate`
/// 产出的 `.pub` 内容）。对应私钥 `~/.tauri/marcel-update.key`（空密码，
/// 不进 git；丢失则无法继续推更新，需换公钥发版）。
///
/// 仅 Windows 使用：Android 的 APK 由系统安装器强制校验签名与已装版本一致，
/// 不走（也无法走）minisign 链。
#[cfg(windows)]
const UPDATE_PUBKEY_B64: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDExQzlENTYxN0FBRDg3MUUKUldRZWg2MTZZZFhKRVNZOGh2OTNBY3JNT0NFYlV0Yy83SklLQTFVWThLUElDaEtLbWVaVE02OFQK";

/// 启动后首次检查的延迟（秒）。
const FIRST_CHECK_DELAY_SECS: u64 = 30;
/// 之后每 4 小时检查一次。
const CHECK_INTERVAL_SECS: u64 = 4 * 60 * 60;
/// 磁盘预检时在安装包大小之外额外保留的空间（MB）。
const DISK_HEADROOM_MB: u64 = 64;

pub const UPDATE_STATE_EVENT: &str = "update://state";

/// 下载/待装文件统一落在这个子目录，目录内一切文件都由本模块管理。
const UPDATE_DIR_NAME: &str = "update";
const PENDING_FILE_NAME: &str = "pending.json";

/// 推送给前端的状态（每次变化 emit `update://state`）。
///
/// `rename_all` 只改**变体名**（Idle → `"idle"`），struct variant 的字段名需要
/// `rename_all_fields` —— 少了它 `release_url` 会原样发给前端，而 TS 侧读的是
/// `releaseUrl`（同仓库 `ssh/auth.rs` 用的是同一组属性）。
#[derive(Debug, Clone, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "status"
)]
pub enum UpdateState {
    Idle,
    /// 发现新版本但未下载（关了自动更新，或 latest.json 缺直链字段）。
    /// 药丸提示，点击跳浏览器（现状行为）。
    Available {
        version: String,
        release_url: String,
    },
    Downloading {
        version: String,
        downloaded: u64,
        total: u64,
    },
    /// 校验通过待装：退出后自动静默安装。
    Ready {
        version: String,
    },
    /// 自动更新失败：药丸一次性提示后可关闭，行为降级为手动下载。
    Failed {
        message: String,
    },
}

/// 已通过校验、等待安装的安装包。
#[derive(Debug, Clone)]
struct PendingInstall {
    version: String,
    installer_path: PathBuf,
}

/// `pending.json`：下载成功后写入，供下次启动恢复未装上的安装包。
#[derive(Debug, Serialize, Deserialize)]
struct PendingUpdateMeta {
    version: String,
    file_name: String,
    sha256: String,
    #[serde(default)]
    signature: String,
}

struct UpdaterInner {
    state: UpdateState,
    pending: Option<PendingInstall>,
    downloading: bool,
    /// 「停止当前下载」请求：切换到「关闭」模式时置位，下载循环每个 chunk 检查
    /// 一次后自行收尾（删 .part、复位 downloading，且**不**写 Failed/Ready ——
    /// 状态已由 `retract_for_off` 收回 Idle）。用标志而不是直接改状态：下载任务
    /// 才是唯一能安全清理临时文件的人。
    cancel_requested: bool,
    /// 用户点过「立即安装」（手动请求）。**关闭模式**下退出钩子靠它区分
    /// 「用户点名要装」与「自动装的」：前者照装，后者跳过。
    manual_install_requested: bool,
    /// 用户点过「立即安装」→ 装完自动重开；自然退出则只静默安装不重启
    /// （窗口自己弹出来反而打扰）。仅 Windows 读取：Android 的安装由系统
    /// 接管并自行重启应用。
    #[cfg_attr(not(windows), allow(dead_code))]
    restart_after_install: bool,
}

pub struct UpdaterState(Mutex<UpdaterInner>);

impl UpdaterInner {
    /// 抢占下载槽位：返回 `true` 表示调用方拿到了这次下载的所有权，必须随后
    /// 起下载任务并在收尾时复位标志；`false` = 已有下载在跑。
    ///
    /// 「查 downloading + 置位」必须是一把锁里的原子动作，且**只能在这里做**：
    /// 拆成「先查后置」的话，两个并发入口会同时判定「没人在下载」，
    /// 各自起一个任务写同一份 `.part`。
    fn try_reserve_download(&mut self) -> bool {
        if self.downloading {
            return false;
        }
        self.downloading = true;
        // 上一次遗留的取消请求不能影响这次下载（正常路径已被下载循环取走，
        // 这里是防御性复位）。
        self.cancel_requested = false;
        true
    }
}

impl UpdaterState {
    fn new(initial: UpdateState, pending: Option<PendingInstall>) -> Self {
        Self(Mutex::new(UpdaterInner {
            state: initial,
            pending,
            downloading: false,
            cancel_requested: false,
            manual_install_requested: false,
            restart_after_install: false,
        }))
    }
}

/// 应用启动时调用（`lib.rs` setup，仅 Windows）：清理上次残留、恢复
/// 未装上的安装包、拉起后台检查循环。
pub fn init(app: &AppHandle) {
    let current_version = app.package_info().version.clone();

    let restored = match update_dir(app) {
        Ok(dir) => cleanup_update_dir(&dir, &current_version),
        Err(e) => {
            log::warn!("更新缓存目录不可用，跳过清理: {}", e);
            None
        }
    };

    let (initial_state, pending) = match &restored {
        Some(p) => (
            UpdateState::Ready {
                version: p.version.clone(),
            },
            Some(p.clone()),
        ),
        None => (UpdateState::Idle, None),
    };
    app.manage(UpdaterState::new(initial_state, pending));

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(FIRST_CHECK_DELAY_SECS)).await;
        loop {
            // 单次检查里的任何 panic 都不能带走整个循环 —— 否则后台更新会在用户
            // 毫无感知的情况下永久停摆（连失败提示都不会有）。捕获后记日志，
            // 下个周期继续。（Android 的网络计量查询走 JNI，是这个循环里最可能
            // 出问题的一环；锁中毒在 apply_state 一侧已按 Err 处理。）
            let result = std::panic::AssertUnwindSafe(tick(&handle))
                .catch_unwind()
                .await;
            if result.is_err() {
                log::error!("更新检查异常（已捕获，下个周期重试）");
            }
            tokio::time::sleep(Duration::from_secs(CHECK_INTERVAL_SECS)).await;
        }
    });
}

fn update_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("获取缓存目录失败: {}", e))?;
    Ok(cache.join(UPDATE_DIR_NAME))
}

// ── 状态写入与事件 ────────────────────────────────────────────────

/// 状态种类（用于变更检测；不带载荷）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StateKind {
    Idle,
    Available,
    Downloading,
    Ready,
    Failed,
}

fn kind_of(state: &UpdateState) -> StateKind {
    match state {
        UpdateState::Idle => StateKind::Idle,
        UpdateState::Available { .. } => StateKind::Available,
        UpdateState::Downloading { .. } => StateKind::Downloading,
        UpdateState::Ready { .. } => StateKind::Ready,
        UpdateState::Failed { .. } => StateKind::Failed,
    }
}

fn apply_state(app: &AppHandle, f: impl FnOnce(&mut UpdaterInner) -> Option<UpdateState>) {
    let Some(state) = app.try_state::<UpdaterState>() else {
        return;
    };
    let Ok(mut inner) = state.0.lock() else {
        return;
    };
    // 变更检测必须在闭包动手之前记下「改动前」的种类：闭包只允许改
    // `downloading`/`pending` 这些辅助字段，状态一律通过返回值
    // 表达。否则拿已被闭包改过的 state 与返回值比较，会永远判定为未变化，
    // 事件静默丢失（Idle → Downloading 就是这么丢的）。
    let prev_kind = kind_of(&inner.state);
    let Some(next) = f(&mut inner) else {
        return;
    };
    let changed = prev_kind != kind_of(&next);
    inner.state = next;
    if changed {
        let _ = app.emit(UPDATE_STATE_EVENT, &inner.state);
    }
}

// ── 检查调度 ─────────────────────────────────────────────────────

/// 单次检查 + 决策 + 执行。检查失败静默（log），不打扰用户。
async fn tick(app: &AppHandle) {
    let mode = {
        let app_state = app.state::<crate::AppState>();
        let settings = app_state.settings.read().await;
        settings.update_mode
    };
    // 「关闭」模式：连检查都不做，进行中的下载也停掉。这里再兜一次底（正常
    // 路径是保存设置时即时生效，见 `on_update_mode_changed`），因为配置也可能
    // 被手工改盘。**必须排在「下载中早退」之前** —— 否则「下载中时把配置改成
    // 关闭」会因为早退而永远收不回来。
    if !mode.checks_for_updates() {
        retract_for_off(app);
        return;
    }

    {
        let state = app.state::<UpdaterState>();
        let Ok(inner) = state.0.lock() else { return };
        if inner.downloading {
            return; // 下载中不打扰，下一周期再见
        }
    }

    // 安装包可能已被系统清理（缓存目录由系统回收）：状态与磁盘不一致时收回 Idle，
    // 别让前端一直挂着一个点了没反应的「已就绪」。
    reset_stale_ready(app);

    // 自动下载的三个前提：模式是「自动更新」、平台支持后台下载、当前网络允许。
    // Android 只在非计量网络下自动下载（移动数据上静默消耗几十 MB 是用户
    // 无法预料的代价）；手动触发（start_update_download）不受这些限制。
    let auto_download = mode.auto_downloads()
        && crate::commands::update::install_kind() != crate::commands::update::InstallKind::None
        && install::is_unmetered_network();
    let current_version = app.package_info().version.to_string();

    let offer = match check_for_update().await {
        Ok(o) => o,
        Err(e) => {
            log::warn!("更新检查失败（下个周期重试）: {}", e);
            return;
        }
    };
    let has_update = {
        let cur = semver::Version::parse(&current_version).ok();
        let lat = semver::Version::parse(&offer.version).ok();
        matches!((cur, lat), (Some(c), Some(l)) if l > c)
    };

    let action = {
        let state = app.state::<UpdaterState>();
        let Ok(inner) = state.0.lock() else { return };
        decide_tick(&inner.state, &offer, has_update, auto_download)
    };

    match action {
        TickAction::KeepCurrent => {}
        TickAction::StayIdle => apply_state(app, |inner| {
            if matches!(inner.state, UpdateState::Idle) {
                None
            } else {
                Some(UpdateState::Idle)
            }
        }),
        TickAction::MarkAvailable(rel) => apply_state(app, |_| {
            Some(UpdateState::Available {
                version: rel.version.clone(),
                release_url: rel.release_url.clone(),
            })
        }),
        TickAction::StartDownload(rel) => {
            // 起不来（已有一个下载在跑）不是错误：状态与进度归先到者所有，
            // 这里静默让路即可。
            let _ = start_download(app, rel);
        }
    }
}

enum TickAction {
    KeepCurrent,
    StayIdle,
    MarkAvailable(LatestRelease),
    StartDownload(LatestRelease),
}

/// 周期检查决策（纯函数，可测）：
/// - Ready / Downloading 保持不动，除非发现了比 Ready 更新的版本；
/// - 无更新：Available / Failed 回到 Idle（下载失败下一周期自动重试）；
/// - 有更新、允许自动下载（开关开 + 平台支持 + 网络允许）、且本平台所需
///   字段齐全 → 下载，否则 Available（降级为提示跳浏览器）。
fn decide_tick(
    current: &UpdateState,
    offer: &LatestRelease,
    has_update: bool,
    auto_download: bool,
) -> TickAction {
    if let UpdateState::Ready { version } = current {
        if !has_update {
            return TickAction::KeepCurrent;
        }
        // 已有更新的待装包：只认更高版本，否则保持。
        let newer = match (
            semver::Version::parse(&offer.version),
            semver::Version::parse(version),
        ) {
            (Ok(new), Ok(ready)) => new > ready,
            _ => false,
        };
        return if newer && auto_download && offer.download_ready() {
            TickAction::StartDownload(offer.clone())
        } else {
            TickAction::KeepCurrent
        };
    }
    if matches!(current, UpdateState::Downloading { .. }) {
        return TickAction::KeepCurrent;
    }
    if !has_update {
        return match current {
            UpdateState::Idle => TickAction::KeepCurrent,
            _ => TickAction::StayIdle,
        };
    }
    if auto_download && offer.download_ready() {
        TickAction::StartDownload(offer.clone())
    } else {
        TickAction::MarkAvailable(offer.clone())
    }
}

// ── 更新方式（三态）切换的即时反应 ────────────────────────────────

/// 「关闭」模式生效：停止一切**自动**行为。
///
/// - 请求取消进行中的下载（下载任务自己删 `.part` 并复位 `downloading`）；
/// - 把「过程类」状态收回 Idle：`Downloading` 是被取消的那次下载（不回退就会
///   永远停在一条不动的进度上），`Available` / `Failed` 是提示类。药丸与移动端
///   浮层随之消失（前端不再展示，也不用手动清 dismissedVersion）；
/// - **不动 Ready**：包已经下载好躺在缓存里，删掉是破坏性的（用户切回「自动
///   更新」还得再下一遍）。它保持为「已就绪」，但前端在关闭模式下一律不展示
///   更新提示，用户可以在设置页手动「检查更新」看到并手动装；退出时也不会自动
///   安装（见 `install::install_on_exit`）。
fn retract_for_off(app: &AppHandle) {
    apply_state(app, |inner| {
        if inner.downloading {
            inner.cancel_requested = true;
        }
        match inner.state {
            UpdateState::Available { .. }
            | UpdateState::Failed { .. }
            | UpdateState::Downloading { .. } => Some(UpdateState::Idle),
            _ => None,
        }
    });
}

/// 是否有下载任务在跑（刚被取消的任务要等它自己复位标志）。
fn is_downloading(app: &AppHandle) -> bool {
    let Some(state) = app.try_state::<UpdaterState>() else {
        return false;
    };
    let Ok(inner) = state.0.lock() else {
        return false;
    };
    inner.downloading
}

/// 下载循环每读到一个 chunk 调一次：返回 true 表示「停止下载」已被请求。
///
/// 只读不消费：分段下载有多条连接同时在跑，若某一段把标志「取走」，其余段就
/// 看不到取消请求了。标志由调用方在收尾时用 [`clear_cancel_request`] 清掉。
fn is_cancel_requested(app: &AppHandle) -> bool {
    let Some(state) = app.try_state::<UpdaterState>() else {
        return false;
    };
    let Ok(inner) = state.0.lock() else {
        return false;
    };
    inner.cancel_requested
}

/// 清掉取消请求（一次下载收尾后调用，避免影响下一次下载）。
fn clear_cancel_request(app: &AppHandle) {
    if let Some(state) = app.try_state::<UpdaterState>() {
        if let Ok(mut inner) = state.0.lock() {
            inner.cancel_requested = false;
        }
    }
}

/// 更新方式变化后的即时反应（保存设置时调用；`tick` 里另有一层兜底）。
///
/// - 切到「关闭」：立刻停掉进行中的下载并收回提示，不等下一个 4 小时周期。
/// - 从「关闭」切回会检查的模式：立刻跑一次检查 —— 否则用户刚打开开关还要
///   等最多 4 小时才可能看到新版本，看起来像「没生效」。
/// - 其余切换（自动更新 ↔ 仅提醒）：不动状态、不额外发请求，下一周期自然生效；
///   正在进行的下载也不打断（它已经是被授权过的动作，半路掐掉只会让人困惑）。
pub fn on_update_mode_changed(app: &AppHandle, previous: UpdateMode, next: UpdateMode) {
    if !next.checks_for_updates() {
        log::info!("更新方式切换为「关闭」：不再检查新版本，停止进行中的下载");
        retract_for_off(app);
        return;
    }
    if previous.checks_for_updates() {
        return;
    }
    log::info!("更新方式已打开，立即检查一次新版本");
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // 上一次下载（可能就是刚刚被「关闭」掐掉的那次）还在收尾时
        // `downloading` 尚未复位，tick 会直接跳过 —— 短暂等它结束再查，
        // 否则「刚把开关打开却什么都没发生」，正是要避免的那种观感。
        for _ in 0..10 {
            if !is_downloading(&handle) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        // 与首查同样的 panic 兜底：一次检查炸掉不能带走后台循环。
        let result = std::panic::AssertUnwindSafe(tick(&handle))
            .catch_unwind()
            .await;
        if result.is_err() {
            log::error!("切换更新方式后的检查异常（已捕获）");
        }
    });
}

/// 待装安装包是否还在磁盘上。
///
/// `Ready` 状态与 `pending` 都只是内存里的一份记录，安装包本体在缓存目录里 ——
/// 那个目录会被系统回收（Android 的 cacheDir 在存储紧张时由系统清理，桌面上
/// 各种磁盘清理工具也会清掉应用缓存）。文件没了之后 `Ready` 就是过期状态。
fn pending_installer_available(pending: Option<&PendingInstall>) -> bool {
    pending.map(|p| p.installer_path.is_file()).unwrap_or(false)
}

/// `Ready` 是否已经过期（安装包不在磁盘上）。
///
/// 过期之后两条路都会坏掉：拉安装器只会静默失败（Android 报「安装包不存在」，
/// Windows 更糟 —— 直接退出应用却什么都没装），而「后台下载」又把它当成「已就绪」
/// 的幂等 no-op 吞掉（前端还当成功）。用户唯一的出路是重启应用。
fn ready_is_stale(state: &UpdateState, pending: Option<&PendingInstall>) -> bool {
    matches!(state, UpdateState::Ready { .. }) && !pending_installer_available(pending)
}

/// 把过期的 `Ready` 收回 `Idle`（清掉 pending）；状态没过期时什么都不做，返回
/// `false`。状态与磁盘的一致性由这一处保证，调用方只管在动作之前调它。
///
/// 只收状态、**不抢跑下载**：接下来照常走既有的检查/下载路径（自动行为交给下一个
/// `tick`，手动行为交给用户点的那次「后台下载」）。
fn reset_stale_ready(app: &AppHandle) -> bool {
    let mut reset = false;
    apply_state(app, |inner| {
        // 双检：apply_state 的闭包在锁内执行，因此这里的判定与写入是原子的
        // （另一条线程刚下好新包并落 Ready 时不会被误收）。
        if !ready_is_stale(&inner.state, inner.pending.as_ref()) {
            return None;
        }
        if let Some(p) = &inner.pending {
            log::warn!(
                "已就绪的安装包已不在磁盘上（可能被系统清理），收回就绪状态: {}",
                p.installer_path.display()
            );
        }
        inner.pending = None;
        reset = true;
        Some(UpdateState::Idle)
    });
    reset
}

/// 已就绪的包是否覆盖得上这次检查到的最新版本（同版本或更新 = 无需重下）。
///
/// 版本号解析不了时按「覆盖」处理：宁可维持原有的幂等 no-op，也不要凭一句解析
/// 不了就重下几十 MB。
fn ready_covers_offer(ready_version: &str, offer_version: &str) -> bool {
    match (
        semver::Version::parse(ready_version),
        semver::Version::parse(offer_version),
    ) {
        (Ok(ready), Ok(offer)) => ready >= offer,
        _ => true,
    }
}

/// 手动触发下载（设置页「检查更新」有结果后的「后台下载」按钮；手机端
/// 也用于用户明确要求在移动数据下下载）。
/// 重新检查一次 latest.json 以取得直链等字段，避免跨 command 传大状态。
/// 注意：**不受更新方式限制** —— 这是用户当面点的动作，更新方式管的是
/// 「自动行为」（是否自动检查、自动下载、退出自动安装）。
pub async fn start_update_download_impl(app: &AppHandle) -> Result<(), AppError> {
    // 安装包被系统清理时，Ready 只是过期记录：先收回 Idle，否则后面无论检查
    // 成不成功都不会真的下载（Ready 分支直接 return Ok）。
    reset_stale_ready(app);
    let ready_version: Option<String> = {
        let state = app.state::<UpdaterState>();
        let inner = state
            .0
            .lock()
            .map_err(|_| AppError::Other("更新器状态被占用".into()))?;
        if inner.downloading {
            return Ok(()); // 幂等：已在下载
        }
        match &inner.state {
            UpdateState::Ready { version } => Some(version.clone()),
            _ => None,
        }
    };

    if crate::commands::update::install_kind() == crate::commands::update::InstallKind::None {
        return Err(AppError::Other(
            "当前平台不支持后台自动更新，请前往下载页手动安装".into(),
        ));
    }

    let current_version = app.package_info().version.to_string();
    let offer = check_for_update().await?;
    // 已就绪的包不比最新版旧 → 幂等 no-op（原语义：无需重复下载）。但已就绪的
    // 版本**低于**最新版时必须继续往下走去下载新版本 —— 不能被一句「已就绪」
    // 静默吞掉：设置页发现更新版本时给的正是「后台下载」。
    if let Some(ready) = ready_version {
        if ready_covers_offer(&ready, &offer.version) {
            return Ok(());
        }
        log::info!(
            "已就绪的版本 {} 低于最新版本 {}，重新下载",
            ready,
            offer.version
        );
    }
    let lat = semver::Version::parse(&offer.version).ok();
    let cur = semver::Version::parse(&current_version).ok();
    let has_update = matches!((cur, lat), (Some(c), Some(l)) if l > c);
    if !has_update {
        return Err(AppError::Other("已是最新版本，无需下载".into()));
    }
    if !offer.download_ready() {
        return Err(AppError::Other(
            "该版本未提供自动更新包，请前往下载页手动安装".into(),
        ));
    }
    // 抢占失败 = 已有下载在跑：对用户而言这就是「后台下载中」，不算错误。
    let _ = start_download(app, offer);
    Ok(())
}

/// 当前状态快照（前端挂载时兜底拉取，防丢事件）。
pub async fn get_update_state_impl(app: &AppHandle) -> Result<UpdateState, AppError> {
    let state = app.state::<UpdaterState>();
    let inner = state
        .0
        .lock()
        .map_err(|_| AppError::Other("更新器状态被占用".into()))?;
    Ok(inner.state.clone())
}

/// 立即安装已就绪的更新。是否中断 Agent/SSH 由前端在调用前确认。
/// - Windows：退出应用，退出钩子静默安装并自动重启到新版本；
/// - Android：拉起系统安装器，由用户在系统界面确认。
pub async fn install_update_now_impl(app: &AppHandle) -> Result<(), AppError> {
    // 安装包可能已被系统清理（见 `reset_stale_ready`）：先收回过期的就绪状态再
    // 往下走，否则会拿着一个不存在的路径去拉安装器 —— Android 报「安装包不存在」，
    // Windows 更糟（`launch_now` 直接 exit(0)，安装器没起来、应用却已经关了）。
    // 收回后前端会收到 Idle，「后台下载」按钮随之回来，用户当场就能重下。
    if reset_stale_ready(app) {
        return Err(AppError::Other(
            "安装包已不在磁盘上（可能被系统清理），请重新下载更新".into(),
        ));
    }
    let pending = {
        let state = app.state::<UpdaterState>();
        let inner = state
            .0
            .lock()
            .map_err(|_| AppError::Other("更新器状态被占用".into()))?;
        inner
            .pending
            .clone()
            .ok_or_else(|| AppError::Other("暂无已就绪的更新".into()))?
    };
    // 标记「用户点名要装」：关闭模式下退出钩子靠它放行 —— 否则用户切到
    // 「关闭」后点「立即安装」会被自己的模式门控挡下，点了没反应。
    if let Some(state) = app.try_state::<UpdaterState>() {
        if let Ok(mut inner) = state.0.lock() {
            inner.manual_install_requested = true;
        }
    }
    install::launch_now(app, &pending, true)
}

// ── 下载与校验 ───────────────────────────────────────────────────

/// 下载结果：完成（拿到安装包路径）或按用户要求中途停止。
enum DownloadOutcome {
    Done(PathBuf),
    Cancelled,
}

/// 启动下载任务。返回 `true` 表示本次调用**真的起了**一个下载任务；
/// `false` = 已有下载在跑，本次让路（调用方不得当成错误）。
///
/// 「是否已在下载」的判定与 spawn 决策必须在**同一临界区**里：`apply_state`
/// 的闭包返回 `None` 只表示「状态不写」，若 spawn 仍无条件执行，两个并发
/// 调用者（`tick` 的自动下载与设置页的「后台下载」都在 `check_for_update`
/// 之后才落 `downloading`）会各起一个任务写同一个 `.part` —— 互相截断、
/// 抢 rename 源，带宽翻倍，还可能把已经下好的包报成失败。
fn start_download(app: &AppHandle, offer: LatestRelease) -> bool {
    // 闭包只改辅助字段（downloading），状态通过返回值表达 —— 见 apply_state 说明。
    // 抢占结果用 Cell 带出闭包：闭包在锁内执行，所以「判定 + 置位 + 写状态」
    // 是一次原子动作。
    let reserved = std::cell::Cell::new(false);
    apply_state(app, |inner| {
        if !inner.try_reserve_download() {
            return None;
        }
        reserved.set(true);
        Some(UpdateState::Downloading {
            version: offer.version.clone(),
            downloaded: 0,
            total: offer.assets.size.unwrap_or(0),
        })
    });
    if !reserved.get() {
        return false;
    }

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // 下载任务里的任何 panic 都必须在这里兜住：`downloading` 槽位是「有没有
        // 下载在跑」的唯一依据，被 panic 带走就永远是 true —— `tick` 每个周期都
        // 在早退、设置页的「后台下载」也把它当幂等 no-op 静默吞掉，更新器在主进程
        // 生命周期内静默停摆（连失败提示都不会有）。与 `tick` 的 catch_unwind 同
        // 一个理由。捕获后按「下载失败」落状态：槽位复位，下个周期自动重试。
        let result = std::panic::AssertUnwindSafe(run_download_task(&handle, &offer))
            .catch_unwind()
            .await;
        if result.is_err() {
            log::error!("更新下载任务异常（已捕获），复位下载槽位");
            apply_state(&handle, |inner| {
                inner.downloading = false;
                inner.cancel_requested = false;
                Some(UpdateState::Failed {
                    message: "更新下载异常中断，将在下次检查时自动重试".into(),
                })
            });
        }
    });
    true
}

/// 下载任务主体（`start_download` 真正 spawn 的那段）。任何**正常**退出路径都
/// 复位下载槽位；panic 由外层的 catch_unwind 兜住。
async fn run_download_task(app: &AppHandle, offer: &LatestRelease) {
    let version_for_state = offer.version.clone();
    match run_download(app, offer).await {
        Ok(DownloadOutcome::Done(path)) => {
            log::info!("更新包就绪: {}", path.display());
            let version = version_for_state;
            apply_state(app, |inner| {
                inner.pending = Some(PendingInstall {
                    version: version.clone(),
                    installer_path: path.clone(),
                });
                // 清掉可能刚落下的取消请求：包已经完整下好并校验通过，
                // 留着会把下一次下载掐死在第一个 chunk。
                inner.cancel_requested = false;
                Some(UpdateState::Ready { version })
            });
        }
        Ok(DownloadOutcome::Cancelled) => {
            // 用户把更新方式切成了「关闭」：run_download 已删掉 .part，
            // 状态也已由 retract_for_off 收回 Idle —— 这里只复位下载标志，
            // **不写 Failed**（没出错，别拿红色提示吓人）。
            log::info!("更新下载已按用户要求停止（更新方式切为关闭）");
            reset_downloading(app);
            return;
        }
        Err(msg) => {
            log::warn!("自动更新下载失败: {}", msg);
            // 清掉残留 .part，目录回到只剩可用文件的状态
            if let Ok(dir) = update_dir(app) {
                let part = format!("{}.part", installer_file_name(&offer.version));
                let _ = std::fs::remove_file(dir.join(part));
            }
            apply_state(app, |inner| {
                inner.downloading = false;
                inner.cancel_requested = false;
                Some(UpdateState::Failed { message: msg })
            });
            return;
        }
    }
    // 成功路径的 downloading 复位
    reset_downloading(app);
}

/// 复位下载标志（不动状态）。
fn reset_downloading(app: &AppHandle) {
    if let Some(state) = app.try_state::<UpdaterState>() {
        if let Ok(mut inner) = state.0.lock() {
            inner.downloading = false;
        }
    }
}

/// 下载与校验所需的注入点：把 `AppHandle` 依赖收成「目录 / 取消 / 进度 / 验签公钥」，
/// 好让「下发 → 落盘 → sha256 + 签名把关 → 写 pending.json」这整条路径能在进程内
/// 用本地 HTTP 服务端到端跑（见文件末尾的 `update_gate`）。生产路径由
/// [`run_download`] 装配，语义与抽取前逐字节一致。
struct DownloadEnv<'a> {
    dir: PathBuf,
    cancel: &'a (dyn Fn() -> bool + Sync),
    progress: &'a (dyn Fn(u64, u64) + Sync),
    /// 下载被判定为「按用户要求停止」时的收尾（生产 = 清掉取消请求；测试给空操作）。
    on_cancelled: &'a (dyn Fn() + Sync),
    /// Windows 验签公钥（minisign base64 行）。`None` = 用内置生产公钥；只有测试
    /// 传 `Some`（测试向量由另一把私钥签发，生产公钥必然验不过）。
    #[cfg_attr(not(windows), allow(dead_code))]
    verify_pubkey: Option<String>,
}

async fn run_download(app: &AppHandle, offer: &LatestRelease) -> Result<DownloadOutcome, String> {
    let dir = update_dir(app)?;
    let env = DownloadEnv {
        dir,
        cancel: &|| is_cancel_requested(app),
        progress: &|downloaded, total| {
            emit_progress(app, offer.version.clone(), downloaded, total);
        },
        on_cancelled: &|| clear_cancel_request(app),
        verify_pubkey: None,
    };
    run_download_in(&env, offer).await
}

async fn run_download_in(
    env: &DownloadEnv<'_>,
    offer: &LatestRelease,
) -> Result<DownloadOutcome, String> {
    let dir = env.dir.clone();
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建更新缓存目录: {}", e))?;

    let expected_size = offer.assets.size.ok_or("更新包大小未知")?;
    if expected_size == 0 {
        return Err("更新包大小信息无效".into());
    }

    // 磁盘预检：包大小 + 余量
    match fs4::available_space(&dir) {
        Ok(avail) if avail < expected_size + DISK_HEADROOM_MB * 1024 * 1024 => {
            return Err("磁盘空间不足，已停止自动下载".into());
        }
        Ok(_) => {}
        Err(e) => log::warn!("磁盘空间检查失败（继续尝试下载）: {}", e),
    }

    let file_name = installer_file_name(&offer.version);
    let part_path = dir.join(format!("{}.part", file_name));
    let final_path = dir.join(&file_name);

    // 下载候选：GitHub 直链优先，installer_mirrors 逐个 fallback。
    // 镜像只需网络可达即可——内容安全由 sha256（+ Windows 签名）校验兜底，
    // 镜像无需被信任。
    let mut candidates: Vec<String> = Vec::new();
    if let Some(url) = &offer.assets.installer_url {
        candidates.push(url.clone());
    }
    candidates.extend(offer.assets.installer_mirrors.iter().cloned());
    if candidates.is_empty() {
        return Err("更新包直链缺失".into());
    }

    // 分段并发下载：GitHub 这类线路按单连接限速（实测单连接 0.02MB/s、16 连接
    // 0.25MB/s），单连接顺序流只能跑到浏览器的水平。模块内部会先探测 Range
    // 支持情况，不支持时自动退回单连接顺序流。
    let download = crate::download::SegmentedDownload {
        urls: candidates,
        part_path: part_path.clone(),
        expected_size,
        cancel: env.cancel,
        progress: env.progress,
    };
    match download.run().await? {
        crate::download::DownloadOutcome::Cancelled => {
            (env.on_cancelled)();
            return Ok(DownloadOutcome::Cancelled);
        }
        crate::download::DownloadOutcome::Done => {}
    }

    // 完整性校验：sha256 两端都做（防传输损坏/被替换）；来源可信校验 Windows
    // 另加 minisign 验签（Android 的 APK 由系统安装器强制校验签名与已装版本
    // 一致，签名不符装不上）。
    //
    // 分段下载无法边下边算整体哈希，所以这里对落盘文件读一遍：多一次读盘换
    // 十几倍下载速度，划算。
    let actual_hash = hash_file(&part_path)?;
    let expected_hash = offer.assets.sha256.clone().unwrap_or_default();
    if !hash_equal(&actual_hash, &expected_hash) {
        let _ = std::fs::remove_file(&part_path);
        return Err("更新包校验失败（内容不完整或被篡改）".into());
    }
    #[cfg(windows)]
    {
        // 公钥在这一步才解析（不在下载前就解析）：保持与抽取前一致的失败顺序 ——
        // 内置公钥坏掉时报的是「签名验证失败」，且不白下这一趟的语义不变。
        let pubkey_line = match env.verify_pubkey.as_deref() {
            Some(line) => line.to_string(),
            None => decode_wrapped_pubkey()?,
        };
        if let Err(e) = verify_signature_with(
            &pubkey_line,
            &final_bytes_of(&part_path)?,
            offer.assets.signature.as_deref().unwrap_or(""),
        ) {
            let _ = std::fs::remove_file(&part_path);
            return Err(format!("更新包签名验证失败: {}", e));
        }
    }

    // 只保留最新一份：清掉旧包与旧 pending
    cleanup_old_installers(&dir, &file_name);
    std::fs::rename(&part_path, &final_path).map_err(|e| format!("无法保存更新包: {}", e))?;
    let meta = PendingUpdateMeta {
        version: offer.version.clone(),
        file_name: file_name.clone(),
        sha256: expected_hash,
        signature: offer.assets.signature.clone().unwrap_or_default(),
    };
    let meta_json =
        serde_json::to_string(&meta).map_err(|e| format!("无法序列化更新元数据: {}", e))?;
    std::fs::write(dir.join(PENDING_FILE_NAME), meta_json)
        .map_err(|e| format!("无法写入更新元数据: {}", e))?;

    // 最终进度由下载模块按真实总大小推过一次，这里不再重复 emit
    Ok(DownloadOutcome::Done(final_path))
}

/// 对落盘文件算 sha256（hex）。
///
/// 分段并发下载没法边下边算整体哈希，只能下完读一遍。分块读，避免为了算哈希
/// 把整个安装包读进内存。
fn hash_file(path: &Path) -> Result<String, String> {
    use std::io::Read;

    let mut file = std::fs::File::open(path).map_err(|e| format!("无法读取下载文件: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("读取下载文件失败: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// 本平台安装包的本地文件名（latest.json 的直链指向同一份资产，文件名只用于
/// 落盘与清理，必须两端一致地由版本号推导，不能各处硬编码）。
fn installer_file_name(version: &str) -> String {
    if cfg!(windows) {
        format!("Marcel-SSH_{}_x64-setup.exe", version)
    } else if cfg!(target_os = "android") {
        format!("Marcel-SSH_{}_universal-release.apk", version)
    } else {
        format!("Marcel-SSH_{}_installer", version)
    }
}

#[cfg(windows)]
fn final_bytes_of(path: &Path) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("无法读取下载文件: {}", e))
}

fn emit_progress(app: &AppHandle, version: String, downloaded: u64, total: u64) {
    let Some(state) = app.try_state::<UpdaterState>() else {
        return;
    };
    let Ok(mut inner) = state.0.lock() else {
        return;
    };
    if let UpdateState::Downloading { .. } = inner.state {
        inner.state = UpdateState::Downloading {
            version,
            downloaded,
            total,
        };
        let _ = app.emit(UPDATE_STATE_EVENT, &inner.state);
    }
}

/// sha256 十六进制比较（大小写不敏感；发布侧误带大写/0x 前缀也不误判）。
fn hash_equal(actual: &str, expected: &str) -> bool {
    let norm = |s: &str| s.trim().trim_start_matches("0x").to_ascii_lowercase();
    !expected.is_empty() && norm(actual) == norm(expected)
}

// ── 签名验证（仅 Windows） ───────────────────────────────────────
// Android 的 APK 不做 minisign：系统安装器会强制校验「新包签名 == 已装版本
// 签名」，签名不一致根本装不上，比自校验更硬。

/// 校验安装包签名。`signature_b64` 是 `tauri signer sign` 产出的 `.sig`
/// 文件内容（base64 包裹的 minisign 签名文件）。
#[cfg(windows)]
fn verify_signature(file_bytes: &[u8], signature_b64: &str) -> Result<(), String> {
    verify_signature_with(&decode_wrapped_pubkey()?, file_bytes, signature_b64)
}

/// 同上，公钥由调用方给：生产走内置公钥（[`verify_signature`]），测试换测试公钥
/// 才能覆盖「签名**正确**时必须通过」这半边 —— 只测拒绝的话，一个「恒拒绝」的
/// 回归（公钥抄错、比较写反）照样全绿。
#[cfg(windows)]
fn verify_signature_with(
    pubkey_line: &str,
    file_bytes: &[u8],
    signature_b64: &str,
) -> Result<(), String> {
    let signature_text = decode_wrapped_b64(signature_b64)?;

    let pubkey = minisign_verify::PublicKey::from_base64(pubkey_line)
        .map_err(|e| format!("签名公钥无效: {}", e))?;
    let signature = minisign_verify::Signature::decode(&signature_text)
        .map_err(|e| format!("签名格式无效: {}", e))?;
    // allow_legacy=false：只接受标准 minisign ed25519 签名（tauri signer 产出）。
    pubkey
        .verify(file_bytes, &signature, false)
        .map_err(|e| format!("签名不匹配: {}", e))
}

/// 解码 base64 包裹的 minisign 文件，取其中的纯 base64 主体行
/// （`.pub` = 注释行 + 公钥行；`.sig` = 多行注释/签名结构）。
#[cfg(windows)]
fn decode_wrapped_b64(wrapped: &str) -> Result<String, String> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(wrapped.trim())
        .map_err(|e| format!("base64 解码失败: {}", e))?;
    String::from_utf8(decoded).map_err(|e| format!("签名文件不是有效 UTF-8: {}", e))
}

#[cfg(windows)]
fn decode_wrapped_pubkey() -> Result<String, String> {
    let text = decode_wrapped_b64(UPDATE_PUBKEY_B64)?;
    text.lines()
        .nth(1)
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .ok_or_else(|| "公钥文件格式无效".to_string())
}

// ── 启动清理与恢复 ───────────────────────────────────────────────

/// 恢复待装包时的校验（与下载路径同一套规则）。
///
/// sha256 只能证明「文件与 pending.json 自述一致」，而 pending.json 与安装包
/// 都在用户（以及本应用插件）可写的缓存目录里 —— 只信它自带的 sha256 等于
/// 自证。因此 Windows 必须用内置公钥重新验签：攻击者可以换文件、换元数据，
/// 但签不出一个能过公钥的包。
fn verify_pending_bytes(bytes: &[u8], meta: &PendingUpdateMeta) -> bool {
    if !hash_equal(&format!("{:x}", Sha256::digest(bytes)), &meta.sha256) {
        return false;
    }
    #[cfg(windows)]
    {
        verify_signature(bytes, &meta.signature).is_ok()
    }
    #[cfg(not(windows))]
    {
        // Android：APK 的可信性由系统安装器强制校验（签名不符无法覆盖安装），
        // 这里只负责完整性。
        true
    }
}

/// 启动兜底清理：目录内一切文件都由更新器管理，无主/过期文件直接删。
/// 返回值得以恢复的待装安装包（上次没装上、比当前版本新、校验通过）。
fn cleanup_update_dir(dir: &Path, current_version: &semver::Version) -> Option<PendingInstall> {
    cleanup_update_dir_with(dir, current_version, &verify_pending_bytes)
}

/// 同上，校验函数可注入：测试用它绕过「必须持有真实签名」这一层，单独验证
/// 版本判断 / 保留 / 清理逻辑（校验规则本身另有专门测试）。
fn cleanup_update_dir_with(
    dir: &Path,
    current_version: &semver::Version,
    verify: &dyn Fn(&[u8], &PendingUpdateMeta) -> bool,
) -> Option<PendingInstall> {
    if !dir.exists() {
        return None;
    }

    // 1. 无条件删除所有 .part 半成品
    let entries = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) => {
            log::warn!("读取更新缓存目录失败: {}", e);
            return None;
        }
    };
    let mut file_names: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) == Some("part") {
            let _ = std::fs::remove_file(&p);
        } else {
            file_names.push(p);
        }
    }

    let meta_path = dir.join(PENDING_FILE_NAME);
    let meta: Option<PendingUpdateMeta> = std::fs::read(&meta_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());

    let Some(meta) = meta else {
        // 无有效元数据：其余文件全是无主文件，清掉（兼容 = 保持原样，但本目录
        // 没有任何用户数据，删除是安全的且是「最多只留一份」承诺的一部分）。
        for p in file_names {
            if p.file_name().and_then(|n| n.to_str()) != Some(PENDING_FILE_NAME) {
                let _ = std::fs::remove_file(&p);
            }
        }
        let _ = std::fs::remove_file(&meta_path);
        return None;
    };

    let installer_path = dir.join(&meta.file_name);
    let version_ok = semver::Version::parse(&meta.version)
        .map(|v| v > *current_version)
        .unwrap_or(false);
    let file_ok = installer_path
        .exists()
        .then(|| std::fs::read(&installer_path).ok())
        .flatten()
        .map(|bytes| verify(&bytes, &meta))
        .unwrap_or(false);

    if version_ok && file_ok {
        // 上次没装上的包：恢复为待装（完整性与来源都已重新校验）；目录里
        // 可能残留的其他无主文件一并清掉（只保留这一份的承诺）。
        for p in file_names {
            if p != installer_path
                && p.file_name().and_then(|n| n.to_str()) != Some(PENDING_FILE_NAME)
            {
                let _ = std::fs::remove_file(&p);
            }
        }
        Some(PendingInstall {
            version: meta.version,
            installer_path,
        })
    } else {
        let _ = std::fs::remove_file(&installer_path);
        let _ = std::fs::remove_file(&meta_path);
        for p in file_names {
            let _ = std::fs::remove_file(&p);
        }
        None
    }
}

/// 只保留最新一份：删除目录内除 `keep`（及其 .part）之外的安装包与 pending。
fn cleanup_old_installers(dir: &Path, keep: &str) {
    let keep_part = format!("{}.part", keep);
    // 两端的安装包后缀都要认：换平台/换构建不会留下无人清理的旧包。
    let is_installer = |name: &str| {
        ["exe", "apk"].iter().any(|ext| {
            name.ends_with(&format!(".{}", ext)) || name.ends_with(&format!(".{}.part", ext))
        })
    };
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name == keep || name == keep_part || name == PENDING_FILE_NAME {
                continue;
            }
            if is_installer(&name) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

// ── 安装入口（平台实现见 install.rs） ────────────────────────────

/// 退出钩子（`RunEvent::Exit`）：Windows 有待装包时延迟静默运行 NSIS 安装器。
/// 其他平台没有「退出时安装」这一步 —— Android 的安装必须由用户在系统安装器
/// 界面确认（`install::launch_now`）。
#[cfg(windows)]
pub fn install_on_exit(app: &AppHandle) {
    install::install_on_exit(app);
}

#[cfg(test)]
mod tests {
    use super::*;
    // 只在测试里用（非测试构建下是未使用导入，故不放在模块顶部）。
    use std::str::FromStr;

    use crate::commands::update::ReleaseAssets;

    // 测试专用密钥对（scratch/test-update.key，已删除私钥；仅公钥与向量入库）。
    // 生成方式：
    //   pnpm tauri signer generate -w scratch/test-update.key --password "" --ci
    //   printf 'marcel-update-test-payload\n' > scratch/payload.bin
    //   TAURI_SIGNING_PRIVATE_KEY_PATH=... pnpm tauri signer sign scratch/payload.bin
    #[cfg(windows)]
    const TEST_PUBKEY_WRAP_B64: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDk0ODZGQ0M5QURGOTFBOTIKUldTU0d2bXR5ZnlHbEZGenJVaHU5N0EwSHFWZGltdWkzVDdqcHUyNjhnUUxqbmIwa3d3RVhUN0oK";
    #[cfg(windows)]
    const TEST_SIG_WRAP_B64: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTU0d2bXR5ZnlHbEJsSHcwY2NYZnY1d0RJMGVzaTc0bzRGdTkwTDkzZENFRy9DaW1jdzRoZVI5ZXlqVm1KNTMwOEhqUS9DSUpOM3FOcS9BbjVmaGIrWUVGVjgyQ3V0WFFnPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzg5MTk4MDIwCWZpbGU6cGF5bG9hZC5iaW4KY01Udk4wYUxidFlVMlZFVWd3aFhmQ2RRK29NeDdhWXAvTVRIa3hoa3hzSm5PTWVCNmJPOFkrNGdwdnNkRGpibUVqWS9XOHNCT0FBdXQzak1ONEpJRHc9PQo=";
    #[cfg(windows)]
    const TEST_PAYLOAD: &[u8] = b"marcel-update-test-payload\n";

    fn release_assets(sig: &str) -> ReleaseAssets {
        ReleaseAssets {
            installer_url: Some("https://example.com/x.exe".into()),
            installer_mirrors: Vec::new(),
            signature: Some(sig.into()),
            sha256: Some("aa".into()),
            size: Some(1),
        }
    }

    fn offer(v: &str, ready: bool) -> LatestRelease {
        LatestRelease {
            version: v.into(),
            release_url: "https://example.com/tag".into(),
            assets: if ready {
                release_assets("sig")
            } else {
                ReleaseAssets::default()
            },
        }
    }

    // ── 事件载荷形状 ──
    /// 回归：`release_url` 必须序列化成 `releaseUrl`。
    ///
    /// 枚举级 `rename_all` 只改变体名、**不**改 struct variant 的字段名；少了
    /// `rename_all_fields` 时前端读到的 `releaseUrl` 是 undefined —— 表现为
    /// 「点标题栏「新版本」药丸 → 药丸消失、浏览器不打开、也没有任何报错」。
    #[test]
    fn update_state_serializes_camel_case_fields() {
        let available = serde_json::to_string(&UpdateState::Available {
            version: "1.5.0".into(),
            release_url: "https://example.com/tag/v1.5.0".into(),
        })
        .expect("serialize");
        assert!(
            available.contains("\"status\":\"available\""),
            "{}",
            available
        );
        assert!(available.contains("\"releaseUrl\""), "{}", available);
        assert!(!available.contains("release_url"), "{}", available);

        assert_eq!(
            serde_json::to_string(&UpdateState::Idle).unwrap(),
            "{\"status\":\"idle\"}"
        );
        let downloading = serde_json::to_string(&UpdateState::Downloading {
            version: "1.5.0".into(),
            downloaded: 1,
            total: 2,
        })
        .unwrap();
        assert!(
            downloading.contains("\"status\":\"downloading\""),
            "{}",
            downloading
        );
        let ready = serde_json::to_string(&UpdateState::Ready {
            version: "1.5.0".into(),
        })
        .unwrap();
        assert!(ready.contains("\"status\":\"ready\""), "{}", ready);
        let failed = serde_json::to_string(&UpdateState::Failed {
            message: "x".into(),
        })
        .unwrap();
        assert!(failed.contains("\"status\":\"failed\""), "{}", failed);
    }

    // ── 签名验证（仅 Windows；Android 走系统 APK 签名校验） ──

    /// 内置生产公钥必须能被解析 —— 换钥发版时要手工把 `.pub` 的 base64 抄进
    /// `UPDATE_PUBKEY_B64`，抄错会让所有客户端静默更新失败，这里挡住这种错。
    #[cfg(windows)]
    #[test]
    fn production_pubkey_parses() {
        let line = decode_wrapped_pubkey().expect("内置公钥应可解析");
        assert!(
            line.starts_with("RW"),
            "minisign 公钥行应以 RW 开头: {}",
            line
        );
        assert!(minisign_verify::PublicKey::from_base64(&line).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn wrapped_pubkey_extracts_second_line() {
        let key = decode_wrapped_b64(TEST_PUBKEY_WRAP_B64).unwrap();
        assert!(key.contains("untrusted comment"));
        let line = key.lines().nth(1).unwrap().trim();
        assert!(minisign_verify::PublicKey::from_base64(line).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn signature_verifies_against_test_vector() {
        let sig = decode_wrapped_b64(TEST_SIG_WRAP_B64).unwrap();
        assert!(sig.starts_with("untrusted comment"));
        let pubkey_text = decode_wrapped_b64(TEST_PUBKEY_WRAP_B64).unwrap();
        let pubkey =
            minisign_verify::PublicKey::from_base64(pubkey_text.lines().nth(1).unwrap().trim())
                .unwrap();
        let signature = minisign_verify::Signature::decode(&sig).unwrap();
        pubkey
            .verify(TEST_PAYLOAD, &signature, false)
            .expect("valid signature must verify");
    }

    #[cfg(windows)]
    #[test]
    fn tampered_payload_fails_verification() {
        let sig = decode_wrapped_b64(TEST_SIG_WRAP_B64).unwrap();
        let pubkey_text = decode_wrapped_b64(TEST_PUBKEY_WRAP_B64).unwrap();
        let pubkey =
            minisign_verify::PublicKey::from_base64(pubkey_text.lines().nth(1).unwrap().trim())
                .unwrap();
        let signature = minisign_verify::Signature::decode(&sig).unwrap();
        let tampered = b"marcel-update-test-payloadTAMPERED\n";
        assert!(pubkey.verify(tampered, &signature, false).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn verify_signature_rejects_wrong_payload() {
        assert!(verify_signature(b"not-the-signed-payload", TEST_SIG_WRAP_B64).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn verify_signature_rejects_garbage_signature() {
        assert!(verify_signature(TEST_PAYLOAD, "not base64 at all!").is_err());
    }

    /// Windows 恢复路径必须重新验签：sha256 对得上但签名对不上的包不得恢复
    /// （pending.json 与安装包都在可写缓存目录里，只信自述的 sha256 等于自证）。
    #[cfg(windows)]
    #[test]
    fn cleanup_rejects_pending_without_valid_signature() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let payload = b"installer-bytes";
        let hash = format!("{:x}", Sha256::digest(payload));
        let file_name = "Marcel-SSH_1.5.0_x64-setup.exe";
        write_file(&dir.join(file_name), payload);
        let meta = PendingUpdateMeta {
            version: "1.5.0".into(),
            file_name: file_name.into(),
            sha256: hash,
            signature: String::new(), // 没有签名
        };
        write_file(
            &dir.join(PENDING_FILE_NAME),
            serde_json::to_vec(&meta).unwrap().as_slice(),
        );

        let restored = cleanup_update_dir(dir, &semver::Version::from_str("1.4.0").unwrap());
        assert!(restored.is_none());
        assert!(!dir.join(file_name).exists());
        assert!(!dir.join(PENDING_FILE_NAME).exists());
    }

    // ── hash 比较 ──

    #[test]
    fn hash_equal_case_insensitive_with_0x() {
        assert!(hash_equal("ABC123", "abc123"));
        assert!(hash_equal("abc123", "0xABC123"));
        assert!(!hash_equal("abc123", ""));
        assert!(!hash_equal("abc123", "abc124"));
    }

    // ── 决策 ──

    #[test]
    fn decide_idle_with_update_and_auto_downloads() {
        let action = decide_tick(&UpdateState::Idle, &offer("1.5.0", true), true, true);
        assert!(matches!(action, TickAction::StartDownload(_)));
    }

    #[test]
    fn decide_idle_without_auto_marks_available() {
        let action = decide_tick(&UpdateState::Idle, &offer("1.5.0", true), true, false);
        assert!(matches!(action, TickAction::MarkAvailable(_)));
    }

    /// latest.json 缺直链字段 → 只能 Available（降级跳浏览器）。
    #[test]
    fn decide_idle_fields_missing_marks_available() {
        let action = decide_tick(&UpdateState::Idle, &offer("1.5.0", false), true, true);
        assert!(matches!(action, TickAction::MarkAvailable(_)));
    }

    #[test]
    fn decide_no_update_returns_idle_from_available() {
        let current = UpdateState::Available {
            version: "1.5.0".into(),
            release_url: "https://example.com".into(),
        };
        assert!(matches!(
            decide_tick(&current, &offer("1.4.0", true), false, true),
            TickAction::StayIdle
        ));
    }

    #[test]
    fn decide_ready_kept_unless_newer_version() {
        let current = UpdateState::Ready {
            version: "1.5.0".into(),
        };
        // 相同/更低版本 → 保持
        assert!(matches!(
            decide_tick(&current, &offer("1.5.0", true), true, true),
            TickAction::KeepCurrent
        ));
        assert!(matches!(
            decide_tick(&current, &offer("1.4.0", true), true, true),
            TickAction::KeepCurrent
        ));
        // 更高版本 → 重新下载
        assert!(matches!(
            decide_tick(&current, &offer("1.6.0", true), true, true),
            TickAction::StartDownload(_)
        ));
    }

    #[test]
    fn decide_downloading_always_kept() {
        let current = UpdateState::Downloading {
            version: "1.5.0".into(),
            downloaded: 10,
            total: 100,
        };
        assert!(matches!(
            decide_tick(&current, &offer("1.6.0", true), true, true),
            TickAction::KeepCurrent
        ));
    }

    /// Failed 后检查成功且有更新 → 自动重试下载。
    #[test]
    fn decide_failed_retries_on_next_tick() {
        let current = UpdateState::Failed {
            message: "x".into(),
        };
        assert!(matches!(
            decide_tick(&current, &offer("1.5.0", true), true, true),
            TickAction::StartDownload(_)
        ));
    }

    // ── 启动清理 ──

    fn write_file(path: &Path, bytes: &[u8]) {
        std::fs::write(path, bytes).unwrap();
    }

    #[test]
    fn cleanup_removes_part_files_and_orphans() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        write_file(&dir.join("x.exe.part"), b"half");
        write_file(&dir.join("orphan.exe"), b"orphan");

        let restored = cleanup_update_dir(dir, &semver::Version::from_str("1.4.0").unwrap());
        assert!(restored.is_none());
        assert!(!dir.join("x.exe.part").exists());
        assert!(!dir.join("orphan.exe").exists());
    }

    /// 上次没装上的合法包 → 恢复为待装（这里用宽松校验器，只验证保留逻辑；
    /// 真实校验规则见 `cleanup_rejects_pending_without_valid_signature`）。
    #[test]
    fn cleanup_keeps_valid_newer_pending_package() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let payload = b"installer-bytes";
        let hash = format!("{:x}", Sha256::digest(payload));
        let file_name = installer_file_name("1.5.0");
        write_file(&dir.join(&file_name), payload);
        let meta = PendingUpdateMeta {
            version: "1.5.0".into(),
            file_name: file_name.clone(),
            sha256: hash,
            signature: String::new(),
        };
        write_file(
            &dir.join(PENDING_FILE_NAME),
            serde_json::to_vec(&meta).unwrap().as_slice(),
        );

        let restored = cleanup_update_dir_with(
            dir,
            &semver::Version::from_str("1.4.0").unwrap(),
            &|_, _| true,
        );
        assert!(restored.is_some());
        assert!(dir.join(&file_name).exists());
        assert!(dir.join(PENDING_FILE_NAME).exists());
    }

    /// 已装上的旧包（version <= 当前）→ 删除（安装成功后的清理路径）。
    #[test]
    fn cleanup_removes_current_or_older_package() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let payload = b"installer-bytes";
        let hash = format!("{:x}", Sha256::digest(payload));
        let file_name = installer_file_name("1.4.0");
        write_file(&dir.join(&file_name), payload);
        let meta = PendingUpdateMeta {
            version: "1.4.0".into(),
            file_name: file_name.clone(),
            sha256: hash,
            signature: String::new(),
        };
        write_file(
            &dir.join(PENDING_FILE_NAME),
            serde_json::to_vec(&meta).unwrap().as_slice(),
        );

        let restored = cleanup_update_dir_with(
            dir,
            &semver::Version::from_str("1.4.0").unwrap(),
            &|_, _| true,
        );
        assert!(restored.is_none());
        assert!(!dir.join(&file_name).exists());
        assert!(!dir.join(PENDING_FILE_NAME).exists());
    }

    /// 校验不通过的遗留包 → 删除（下载完成但退出安装失败的损坏场景）。
    /// 走真实校验器：sha256 对不上必须拒绝（两端一致）。
    #[test]
    fn cleanup_removes_corrupted_pending_package() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let file_name = installer_file_name("1.5.0");
        write_file(&dir.join(&file_name), b"corrupted-bytes");
        let meta = PendingUpdateMeta {
            version: "1.5.0".into(),
            file_name: file_name.clone(),
            sha256: "deadbeef".into(),
            signature: String::new(),
        };
        write_file(
            &dir.join(PENDING_FILE_NAME),
            serde_json::to_vec(&meta).unwrap().as_slice(),
        );

        let restored = cleanup_update_dir(dir, &semver::Version::from_str("1.4.0").unwrap());
        assert!(restored.is_none());
        assert!(!dir.join(&file_name).exists());
        assert!(!dir.join(PENDING_FILE_NAME).exists());
    }

    /// Android 不做 minisign 校验（系统安装器强制校验 APK 签名与已装版本一致），
    /// sha256 对得上就应恢复待装包。
    #[cfg(target_os = "android")]
    #[test]
    fn cleanup_restores_pending_without_signature_on_android() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let payload = b"apk-bytes";
        let hash = format!("{:x}", Sha256::digest(payload));
        let file_name = installer_file_name("1.5.0");
        write_file(&dir.join(&file_name), payload);
        let meta = PendingUpdateMeta {
            version: "1.5.0".into(),
            file_name: file_name.clone(),
            sha256: hash,
            signature: String::new(),
        };
        write_file(
            &dir.join(PENDING_FILE_NAME),
            serde_json::to_vec(&meta).unwrap().as_slice(),
        );

        let restored = cleanup_update_dir(dir, &semver::Version::from_str("1.4.0").unwrap());
        assert!(restored.is_some());
    }

    /// 安装包文件名必须由版本号按平台推导（两处硬编码会漂移）。
    #[test]
    fn installer_file_name_matches_platform() {
        let name = installer_file_name("1.5.0");
        #[cfg(windows)]
        assert_eq!(name, "Marcel-SSH_1.5.0_x64-setup.exe");
        #[cfg(target_os = "android")]
        assert_eq!(name, "Marcel-SSH_1.5.0_universal-release.apk");
        assert!(name.contains("1.5.0"));
    }

    /// pending.json 损坏 → 整目录清理，不出错。
    #[test]
    fn cleanup_handles_corrupted_meta() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        write_file(&dir.join(PENDING_FILE_NAME), b"not json");
        write_file(&dir.join("Marcel-SSH_1.5.0_x64-setup.exe"), b"x");

        let restored = cleanup_update_dir(dir, &semver::Version::from_str("1.4.0").unwrap());
        assert!(restored.is_none());
        assert!(!dir.join(PENDING_FILE_NAME).exists());
        assert!(!dir.join("Marcel-SSH_1.5.0_x64-setup.exe").exists());
    }

    /// 目录不存在 → 静默返回（首次安装/用户手动清空的场景）。
    #[test]
    fn cleanup_missing_dir_is_noop() {
        let tmp = tempfile::tempdir().unwrap();
        let restored = cleanup_update_dir(
            &tmp.path().join("nonexistent"),
            &semver::Version::from_str("1.4.0").unwrap(),
        );
        assert!(restored.is_none());
    }

    /// 回归：rename 前清理旧包时不得误删当前下载的 keep 及其 .part
    /// （曾导致「无法保存更新包: os error 2」）。
    #[test]
    fn cleanup_old_installers_keeps_current_download() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let keep = "Marcel-SSH_1.4.1_x64-setup.exe";
        write_file(&dir.join(keep), b"new");
        write_file(&dir.join(format!("{}.part", keep)), b"partial");
        write_file(&dir.join("Marcel-SSH_1.4.0_x64-setup.exe"), b"old");
        write_file(&dir.join(PENDING_FILE_NAME), b"{}");

        cleanup_old_installers(dir, keep);

        assert!(dir.join(keep).exists());
        assert!(dir.join(format!("{}.part", keep)).exists());
        assert!(dir.join(PENDING_FILE_NAME).exists());
        assert!(!dir.join("Marcel-SSH_1.4.0_x64-setup.exe").exists());
    }

    // ── 下载槽位抢占（并发入口） ──
    //
    // `tick` 的自动下载与「后台下载」按钮两条路径都可能到 start_download，
    // 且各自的前置检查都在 `check_for_update()` 网络请求**之前**。抢占必须是
    // 一把锁里的「查 + 置位」，否则两个任务会同时写同一份 `.part`。

    fn idle_inner() -> UpdaterInner {
        UpdaterInner {
            state: UpdateState::Idle,
            pending: None,
            downloading: false,
            cancel_requested: false,
            manual_install_requested: false,
            restart_after_install: false,
        }
    }

    /// 并发抢占只有一个赢家。
    #[test]
    fn download_reservation_has_single_winner_under_concurrency() {
        let inner = Mutex::new(idle_inner());
        let winners = std::sync::atomic::AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..4 {
                scope.spawn(|| {
                    let mut guard = inner.lock().expect("锁不得中毒");
                    if guard.try_reserve_download() {
                        winners.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    }
                });
            }
        });
        assert_eq!(
            winners.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "同时只能有一个下载任务"
        );
    }

    /// 第二次抢占被拒；收尾复位后可重新抢占（失败重试路径）。
    #[test]
    fn second_reservation_is_rejected_and_resets_cancel() {
        let mut inner = idle_inner();
        inner.cancel_requested = true;
        assert!(inner.try_reserve_download(), "第一次必须拿到下载权");
        assert!(!inner.try_reserve_download(), "已有下载时必须让路");
        assert!(!inner.cancel_requested, "上一次的取消请求必须被复位");

        // 下载收尾（成功 / 失败 / 取消）复位标志 → 下一轮还能起
        inner.downloading = false;
        assert!(inner.try_reserve_download(), "收尾后必须可以再起一次");
    }

    /// 进度更新不得让第二个任务进来（槽位只由抢占/reset 改变）。
    #[test]
    fn progress_update_does_not_allow_second_task() {
        let mut inner = idle_inner();
        assert!(inner.try_reserve_download());
        inner.state = UpdateState::Downloading {
            version: "1.5.0".into(),
            downloaded: 1024,
            total: 2048,
        };
        assert!(
            !inner.try_reserve_download(),
            "进度更新不得放第二个任务进来"
        );
    }

    // ── 就绪态与磁盘上安装包的一致性 ──
    //
    // 缓存目录会被系统回收（Android 的 cacheDir / 桌面的磁盘清理工具），而
    // `Ready` + `pending` 只是内存里的一份记录：文件没了之后「立即安装」只会
    // 静默失败、「后台下载」又被当成幂等 no-op 吞掉，用户唯一的出路是重启应用。

    #[test]
    fn stale_ready_is_detected_when_installer_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("Marcel-SSH_1.5.0_x64-setup.exe");
        let ready = UpdateState::Ready {
            version: "1.5.0".into(),
        };
        let install = PendingInstall {
            version: "1.5.0".into(),
            installer_path: path.clone(),
        };

        // 文件不在 → 就绪态过期
        assert!(ready_is_stale(&ready, Some(&install)));
        // 文件在 → 就绪态有效
        write_file(&path, b"installer");
        assert!(!ready_is_stale(&ready, Some(&install)));
    }

    /// 只有「Ready + 文件不在」才算过期：别的状态与别的组合一律不得被动过
    /// （禁止把兼容实现成「没事就清空」）。
    #[test]
    fn stale_ready_never_touches_other_states() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("x.exe");
        let install = PendingInstall {
            version: "1.5.0".into(),
            installer_path: path,
        };
        assert!(!ready_is_stale(&UpdateState::Idle, None));
        assert!(!ready_is_stale(&UpdateState::Idle, Some(&install)));
        assert!(!ready_is_stale(
            &UpdateState::Available {
                version: "1.5.0".into(),
                release_url: "https://example.com".into(),
            },
            Some(&install),
        ));
        assert!(!ready_is_stale(
            &UpdateState::Downloading {
                version: "1.5.0".into(),
                downloaded: 1,
                total: 2,
            },
            None,
        ));
        assert!(!ready_is_stale(
            &UpdateState::Failed {
                message: "x".into()
            },
            None,
        ));
        // 文件在时，Ready + 无 pending 也不算过期（留给下载/清理路径处理）
        assert!(!pending_installer_available(None));
    }

    /// 已就绪的包只在「不比最新版旧」时才算无需重下：更旧的必须放行去重下，
    /// 否则设置页在发现新版本后给的「后台下载」是个静默 no-op。
    #[test]
    fn ready_covers_offer_only_when_not_older() {
        assert!(ready_covers_offer("1.5.0", "1.5.0"));
        assert!(ready_covers_offer("1.6.0", "1.5.0"));
        assert!(!ready_covers_offer("1.5.0", "1.6.0"));
        assert!(!ready_covers_offer("1.4.9", "1.5.0"));
        // 解析不了 → 维持旧的幂等行为（不重下几十 MB）
        assert!(ready_covers_offer("not-a-version", "1.6.0"));
        assert!(ready_covers_offer("1.5.0", "not-a-version"));
    }
}

/// ── 无感更新的自动门控：包下完了，码对不对？ ───────────────────────
///
/// `mod tests` 测的是纯函数（hash 比较、签名向量、决策表），`download.rs` 测的是
/// 「字节有没有下对」。**这两者之间那一跳没人测过**：包在磁盘上了，sha256 与签名
/// 把关到底有没有真的拦住坏包？拦住之后有没有清干净？好包有没有被写进 pending？
/// ——这些正是「更新装上了，但内容不是我们发的那个」的入口。
///
/// 这一组用例把本地 HTTP 服务 + 真实下载器 + 真实校验 + 真实落库拼起来跑，每条都
/// 成对断言「返回结果」与「磁盘残留」，覆盖真机会遇到的失败形态：传输损坏或被换包
/// （sha256 对不上）、下不完整、签名不是我们的（换了包留旧签名）、字段缺失、源不可达。
/// 断言里的错误文案是**用户最终看到的那句**，别改成自造词。
#[cfg(test)]
mod update_gate {
    use super::*;
    use crate::commands::update::ReleaseAssets;
    use std::str::FromStr;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const VERSION: &str = "9.9.9";
    /// 生产公钥验不过测试签名；测试要覆盖「签名正确必须通过」那半边，得换测试公钥。
    #[cfg(windows)]
    const TEST_PUBKEY_WRAP_B64: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDk0ODZGQ0M5QURGOTFBOTIKUldTU0d2bXR5ZnlHbEZGenJVaHU5N0EwSHFWZGltdWkzVDdqcHUyNjhnUUxqbmIwa3d3RVhUN0oK";
    #[cfg(windows)]
    const TEST_SIG_WRAP_B64: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTU0d2bXR5ZnlHbEJsSHcwY2NYZnY1d0RJMGVzaTc0bzRGdTkwTDkzZENFRy9DaW1jdzRoZVI5ZXlqVm1KNTMwOEhqUS9DSUpOM3FOcS9BbjVmaGIrWUVGVjgyQ3V0WFFnPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzg5MTk4MDIwCWZpbGU6cGF5bG9hZC5iaW4KY01Udk4wYUxidFlVMlZFVWd3aFhmQ2RRK29NeDdhWXAvTVRIa3hoa3hzSm5PTWVCNmJPOFkrNGdwdnNkRGpibUVqWS9XOHNCT0FBdXQzak1ONEpJRHc9PQo=";
    #[cfg(windows)]
    const TEST_PAYLOAD: &[u8] = b"marcel-update-test-payload\n";

    fn sha_of(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    fn offer(
        url: &str,
        sha256: Option<&str>,
        size: Option<u64>,
        signature: Option<&str>,
    ) -> LatestRelease {
        LatestRelease {
            version: VERSION.to_string(),
            release_url: "https://example.com/tag/v9.9.9".to_string(),
            assets: ReleaseAssets {
                installer_url: Some(url.to_string()),
                installer_mirrors: Vec::new(),
                signature: signature.map(str::to_string),
                sha256: sha256.map(str::to_string),
                size,
            },
        }
    }

    /// 跑一遍真实下载：本地 HTTP → .part → sha256/签名把关 → rename + pending.json。
    async fn run_offer(
        dir: &Path,
        release: &LatestRelease,
        verify_pubkey: Option<&str>,
    ) -> Result<PathBuf, String> {
        let cancel = || false;
        let progress = |_: u64, _: u64| {};
        let on_cancelled = || {};
        let env = DownloadEnv {
            dir: dir.to_path_buf(),
            cancel: &cancel,
            progress: &progress,
            on_cancelled: &on_cancelled,
            verify_pubkey: verify_pubkey.map(str::to_string),
        };
        match run_download_in(&env, release).await? {
            DownloadOutcome::Done(path) => Ok(path),
            DownloadOutcome::Cancelled => Err("下载被判定为取消（测试里不该发生）".to_string()),
        }
    }

    /// 最小 HTTP 服务：回 `status` + `body`，`declared_len` 可谎报 content-length
    /// （模拟传输被截断）。不认 Range → 客户端走单连接兜底路径（分段路径的字节
    /// 正确性由 `download.rs` 自己的用例覆盖）。返回 (base_url, 命中次数)。
    async fn spawn_server(
        status: u16,
        declared_len: usize,
        body: Vec<u8>,
    ) -> (String, Arc<AtomicU64>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicU64::new(0));
        let hits_task = hits.clone();
        let body = Arc::new(body);
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                hits_task.fetch_add(1, Ordering::Relaxed);
                let body = body.clone();
                tokio::spawn(async move {
                    let mut scratch = [0u8; 2048];
                    let _ = socket.read(&mut scratch).await;
                    let reason = if status == 200 { "OK" } else { "Internal Server Error" };
                    let head = format!(
                        "HTTP/1.1 {status} {reason}\r\ncontent-length: {declared_len}\r\nconnection: close\r\n\r\n"
                    );
                    let _ = socket.write_all(head.as_bytes()).await;
                    if status == 200 {
                        let _ = socket.write_all(&body).await;
                    }
                    let _ = socket.flush().await;
                });
            }
        });
        (format!("http://{addr}"), hits)
    }

    /// 目录里现存的文件名（排序）。
    fn dir_entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        names
    }

    /// 失败之后不能留下任何「会被当成可用更新」的东西：不留成品包、不留 pending.json。
    ///
    /// 只钉这两样 —— 它们才是「坏包被接受」的路径：成品包会被交给安装器，pending 会被
    /// 下次启动的清理当成「上次没装上」捡起来。`.part` 不在此列：生产代码删它就是
    /// `let _ = remove_file(..)`（尽力而为，失败只记日志），且它由启动清理（无差别删
    /// .part）与重试时的 reset 兜底；把「必须当场消失」当契约，等于给门控埋一条可能
    /// 误报的断言。残留能否被扫掉另有 `assert_startup_cleanup_sweeps_residue` 钉住。
    fn assert_no_package_left(dir: &Path) {
        let left = dir_entries(dir);
        assert!(
            !dir.join(installer_file_name(VERSION)).exists(),
            "校验没通过却把包留成了成品：{left:?}"
        );
        assert!(
            !dir.join(PENDING_FILE_NAME).exists(),
            "校验没通过却写了 pending.json（下次启动会被当成「上次没装上」捡起来）：{left:?}"
        );
    }

    /// 残留的 `.part` 必须能被启动清理扫干净（这是「失败后不留垃圾」的真实兜底）。
    fn assert_startup_cleanup_sweeps_residue(dir: &Path) {
        cleanup_update_dir(dir, &semver::Version::from_str("1.0.0").unwrap());
        let left = dir_entries(dir);
        assert!(left.is_empty(), "启动清理应扫掉残留，实际留下：{left:?}");
    }

    #[cfg(windows)]
    fn test_pubkey_line() -> String {
        decode_wrapped_b64(TEST_PUBKEY_WRAP_B64)
            .unwrap()
            .lines()
            .nth(1)
            .unwrap()
            .trim()
            .to_string()
    }

    // ── 正路径：能过校验的包必须真就绪，且落库字段与 latest.json 一致 ──

    #[cfg(windows)]
    #[tokio::test]
    async fn accepts_correctly_signed_payload_and_publishes_pending() {
        let (base, hits) = spawn_server(200, TEST_PAYLOAD.len(), TEST_PAYLOAD.to_vec()).await;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let result = run_offer(
            dir,
            &offer(
                &format!("{base}/pkg"),
                Some(&sha_of(TEST_PAYLOAD)),
                Some(TEST_PAYLOAD.len() as u64),
                Some(TEST_SIG_WRAP_B64),
            ),
            Some(&test_pubkey_line()),
        )
        .await
        .expect("签名正确的包必须就绪");

        assert_eq!(
            std::fs::read(&result).unwrap(),
            TEST_PAYLOAD,
            "落盘内容必须逐字节一致"
        );
        let meta: PendingUpdateMeta = serde_json::from_slice(
            &std::fs::read(dir.join(PENDING_FILE_NAME)).unwrap(),
        )
        .unwrap();
        assert_eq!(meta.version, VERSION);
        assert_eq!(meta.sha256, sha_of(TEST_PAYLOAD), "pending 里记的必须是校验过的 sha");
        assert_eq!(
            meta.signature, TEST_SIG_WRAP_B64,
            "pending 要留签名供启动时复验"
        );
        assert_eq!(
            dir_entries(dir),
            vec![installer_file_name(VERSION), PENDING_FILE_NAME.to_string()],
            "半成品 .part 必须已被 rename 掉"
        );
        assert!(hits.load(Ordering::Relaxed) >= 1);
    }

    /// 生产公钥不接受别的私钥签出来的包 —— 正面钉住「验签没退化」。
    ///
    /// 只测拒绝的话，一个「恒拒绝」的回归（公钥抄错、比较写反）照样全绿；只测
    /// 「注入测试公钥就通过」也证明不了生产路径用的是内置公钥。两条一起才算数。
    #[cfg(windows)]
    #[test]
    fn production_pubkey_does_not_accept_foreign_signature() {
        verify_signature_with(&test_pubkey_line(), TEST_PAYLOAD, TEST_SIG_WRAP_B64)
            .expect("测试公钥应接受测试签名（否则是测试向量坏了）");
        assert!(
            verify_signature(TEST_PAYLOAD, TEST_SIG_WRAP_B64).is_err(),
            "生产公钥竟然接受了别的私钥签的包"
        );
    }

    // ── 失败形态：坏包必须被拒，且不留痕 ──

    /// 测试用的「真实更新包」与此文件上**有效**的签名（非 Windows 没有签名这一关）。
    #[cfg(windows)]
    fn served_payload() -> Vec<u8> {
        TEST_PAYLOAD.to_vec()
    }
    #[cfg(not(windows))]
    fn served_payload() -> Vec<u8> {
        b"a-served-payload-for-gate".to_vec()
    }
    #[cfg(windows)]
    fn served_signature() -> Option<&'static str> {
        Some(TEST_SIG_WRAP_B64)
    }
    #[cfg(not(windows))]
    fn served_signature() -> Option<&'static str> {
        None
    }
    #[cfg(windows)]
    fn served_pubkey() -> Option<String> {
        Some(test_pubkey_line())
    }
    #[cfg(not(windows))]
    fn served_pubkey() -> Option<String> {
        None
    }

    /// 主案「码对不上」：文件确实下完了（长度也对），内容不是 latest.json 声明的
    /// 那一份（发布时 hash 与文件不是同一份，或传输中被换过）。
    ///
    /// Windows 上特意带上**对该文件有效**的签名 —— 把签名关卡排除在外，这样当
    /// sha256 关卡被去掉或写坏时这条必红。否则「签名先报错」会让它假绿：看着在测
    /// sha256，其实一次都没验到它。
    #[tokio::test]
    async fn rejects_body_that_does_not_match_declared_sha256() {
        let served = served_payload();
        let (base, _) = spawn_server(200, served.len(), served.clone()).await;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let err = run_offer(
            dir,
            &offer(
                &format!("{base}/pkg"),
                Some(&sha_of(b"a-different-build-entirely")),
                Some(served.len() as u64),
                served_signature(),
            ),
            served_pubkey().as_deref(),
        )
        .await
        .expect_err("内容与声明的 sha256 不符，必须被拒");
        assert!(
            err.contains("校验失败"),
            "这条必须由 sha256 关卡拦下（错误文案要让用户看懂是校验失败）：{err}"
        );
        assert_no_package_left(dir);
        assert_startup_cleanup_sweeps_residue(dir);
    }

    /// 下不完整：服务端按完整大小报了 content-length，实际只发了一半就断开。
    #[tokio::test]
    async fn rejects_truncated_transfer_instead_of_accepting_partial_bytes() {
        let full = vec![7u8; 4096];
        let half = full[..2048].to_vec();
        let (base, _) = spawn_server(200, full.len(), half).await;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let err = run_offer(
            dir,
            &offer(
                &format!("{base}/pkg"),
                Some(&sha_of(&full)),
                Some(full.len() as u64),
                Some("sig"),
            ),
            None,
        )
        .await
        .expect_err("半截包必须被拒绝");
        assert!(!err.is_empty(), "拒绝时必须给出原因");
        assert_no_package_left(dir);
        assert_startup_cleanup_sweeps_residue(dir);
    }

    /// latest.json 里没有 sha256（发布侧漏写）→ 没有可比对的依据，必须拒。
    /// 同样带上有效签名，保证「被拒」这件事只能归因于缺 sha，而不是签名先报错。
    #[tokio::test]
    async fn rejects_offer_without_sha256() {
        let body = served_payload();
        let (base, _) = spawn_server(200, body.len(), body.clone()).await;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let err = run_offer(
            dir,
            &offer(
                &format!("{base}/pkg"),
                None,
                Some(body.len() as u64),
                served_signature(),
            ),
            served_pubkey().as_deref(),
        )
        .await
        .expect_err("没有 sha256 就没有可比对的依据，必须拒绝");
        assert!(err.contains("校验失败"), "{err}");
        assert_no_package_left(dir);
        assert_startup_cleanup_sweeps_residue(dir);
    }

    /// 大小信息无效时在**发起任何请求之前**就退出（别白下 10MB 再报错）。
    #[tokio::test]
    async fn rejects_zero_size_without_touching_the_network() {
        let (base, hits) = spawn_server(200, 8, b"12345678".to_vec()).await;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let err = run_offer(
            dir,
            &offer(&format!("{base}/pkg"), Some("aa"), Some(0), Some("sig")),
            None,
        )
        .await
        .expect_err("size=0 必须被拒");
        assert!(err.contains("大小"), "{err}");
        assert_eq!(hits.load(Ordering::Relaxed), 0, "不该发起请求");
        assert_no_package_left(dir);
        assert_startup_cleanup_sweeps_residue(dir);
    }

    /// 镜像兜底路径同样受校验约束：主源不可达 → 换镜像，镜像给的是坏包 → 仍然拒绝，
    /// 不会因为「主源已经失败过」就放松要求。
    #[tokio::test]
    async fn mirror_fallback_is_still_verified() {
        let served = b"mirror-serves-wrong-bytes".to_vec();
        let (base, _) = spawn_server(200, served.len(), served.clone()).await;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        // 主源指向一个必然连不上的端口（下载器会换下一个候选）。
        let mut release = offer(
            "http://127.0.0.1:1/pkg",
            Some(&sha_of(b"the-real-payload")),
            Some(served.len() as u64),
            Some("sig"),
        );
        release.assets.installer_mirrors = vec![format!("{base}/mirror")];
        let err = run_offer(dir, &release, None)
            .await
            .expect_err("镜像给的坏包必须被拒绝");
        assert!(!err.is_empty());
        assert_no_package_left(dir);
        assert_startup_cleanup_sweeps_residue(dir);
    }

    /// 源全部不可达 → 如实报错，而不是零字节「成功」。
    #[tokio::test]
    async fn rejects_when_every_source_is_unreachable() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let err = run_offer(
            dir,
            &offer(
                "http://127.0.0.1:1/pkg",
                Some(&sha_of(b"x")),
                Some(1),
                Some("sig"),
            ),
            None,
        )
        .await
        .expect_err("没有可达源必须报错");
        assert!(!err.is_empty());
        assert_no_package_left(dir);
        assert_startup_cleanup_sweeps_residue(dir);
    }

    /// sha256 恰好对上时，签名的两种坏法（缺失 / 不是我们的）也必须拦下。
    #[cfg(windows)]
    #[tokio::test]
    async fn rejects_unsigned_and_wrongly_signed_payloads() {
        // 无签名：latest.json 四个字段凑齐了（download_ready 会放行），但签名空。
        let (base, _) = spawn_server(200, TEST_PAYLOAD.len(), TEST_PAYLOAD.to_vec()).await;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let err = run_offer(
            dir,
            &offer(
                &format!("{base}/pkg"),
                Some(&sha_of(TEST_PAYLOAD)),
                Some(TEST_PAYLOAD.len() as u64),
                None,
            ),
            None,
        )
        .await
        .expect_err("sha 对但没有签名，Windows 上必须拒绝");
        assert!(
            err.contains("签名验证失败"),
            "错误文案要指出签名问题：{err}"
        );
        assert_no_package_left(dir);
        assert_startup_cleanup_sweeps_residue(dir);

        // 签名是别的私钥签的（这里就是测试私钥），生产公钥验不过。
        let (base, _) = spawn_server(200, TEST_PAYLOAD.len(), TEST_PAYLOAD.to_vec()).await;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let err = run_offer(
            dir,
            &offer(
                &format!("{base}/pkg"),
                Some(&sha_of(TEST_PAYLOAD)),
                Some(TEST_PAYLOAD.len() as u64),
                Some(TEST_SIG_WRAP_B64),
            ),
            None,
        )
        .await
        .expect_err("sha 对但签名不是我们的，必须拒绝");
        assert!(err.contains("签名验证失败"), "{err}");
        assert_no_package_left(dir);
        assert_startup_cleanup_sweeps_residue(dir);
    }

    /// 上一次留下的坏 pending（文件在、sha256 对不上 / 签名不是我们的）在启动清理时
    /// 也必须被丢弃并删掉 —— 「码对不上」不能靠「上次已经校验过」蒙过去。
    #[cfg(windows)]
    #[test]
    fn startup_cleanup_drops_pending_whose_bytes_no_longer_match() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let file_name = installer_file_name(VERSION);
        std::fs::write(dir.join(&file_name), b"tampered-after-verification").unwrap();
        let meta = PendingUpdateMeta {
            version: VERSION.to_string(),
            file_name: file_name.clone(),
            sha256: sha_of(TEST_PAYLOAD),
            signature: TEST_SIG_WRAP_B64.to_string(),
        };
        std::fs::write(
            dir.join(PENDING_FILE_NAME),
            serde_json::to_vec(&meta).unwrap(),
        )
        .unwrap();

        let restored = cleanup_update_dir(dir, &semver::Version::from_str("1.0.0").unwrap());
        assert!(restored.is_none(), "被换过的包不得恢复为待装");
        assert!(!dir.join(&file_name).exists(), "坏包要删掉");
        assert!(!dir.join(PENDING_FILE_NAME).exists(), "坏 pending 要删掉");
    }
}
