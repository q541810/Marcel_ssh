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
        TickAction::StartDownload(rel) => start_download(app, rel),
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

/// 手动触发下载（设置页「检查更新」有结果后的「后台下载」按钮；手机端
/// 也用于用户明确要求在移动数据下下载）。
/// 重新检查一次 latest.json 以取得直链等字段，避免跨 command 传大状态。
/// 注意：**不受更新方式限制** —— 这是用户当面点的动作，更新方式管的是
/// 「自动行为」（是否自动检查、自动下载、退出自动安装）。
pub async fn start_update_download_impl(app: &AppHandle) -> Result<(), AppError> {
    {
        let state = app.state::<UpdaterState>();
        let inner = state
            .0
            .lock()
            .map_err(|_| AppError::Other("更新器状态被占用".into()))?;
        if inner.downloading {
            return Ok(()); // 幂等：已在下载
        }
        if matches!(inner.state, UpdateState::Ready { .. }) {
            return Ok(()); // 已就绪待装，无需重复下载
        }
    }

    if crate::commands::update::install_kind() == crate::commands::update::InstallKind::None {
        return Err(AppError::Other(
            "当前平台不支持后台自动更新，请前往下载页手动安装".into(),
        ));
    }

    let current_version = app.package_info().version.to_string();
    let offer = check_for_update().await?;
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
    start_download(app, offer);
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

fn start_download(app: &AppHandle, offer: LatestRelease) {
    // 闭包只改辅助字段（downloading），状态通过返回值表达 —— 见 apply_state 说明。
    apply_state(app, |inner| {
        if inner.downloading {
            return None;
        }
        inner.downloading = true;
        // 上一次遗留的取消请求不能影响这次下载（正常路径已被下载循环取走，
        // 这里是防御性复位）。
        inner.cancel_requested = false;
        Some(UpdateState::Downloading {
            version: offer.version.clone(),
            downloaded: 0,
            total: offer.assets.size.unwrap_or(0),
        })
    });

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let version_for_state = offer.version.clone();
        match run_download(&handle, &offer).await {
            Ok(DownloadOutcome::Done(path)) => {
                log::info!("更新包就绪: {}", path.display());
                let version = version_for_state;
                apply_state(&handle, |inner| {
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
                reset_downloading(&handle);
                return;
            }
            Err(msg) => {
                log::warn!("自动更新下载失败: {}", msg);
                // 清掉残留 .part，目录回到只剩可用文件的状态
                if let Ok(dir) = update_dir(&handle) {
                    let part = format!("{}.part", installer_file_name(&offer.version));
                    let _ = std::fs::remove_file(dir.join(part));
                }
                apply_state(&handle, |inner| {
                    inner.downloading = false;
                    inner.cancel_requested = false;
                    Some(UpdateState::Failed { message: msg })
                });
                return;
            }
        }
        // 成功路径的 downloading 复位
        reset_downloading(&handle);
    });
}

/// 复位下载标志（不动状态）。
fn reset_downloading(app: &AppHandle) {
    if let Some(state) = app.try_state::<UpdaterState>() {
        if let Ok(mut inner) = state.0.lock() {
            inner.downloading = false;
        }
    }
}

async fn run_download(
    app: &AppHandle,
    offer: &LatestRelease,
) -> Result<DownloadOutcome, String> {
    let dir = update_dir(app)?;
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
    let version_for_progress = offer.version.clone();
    let download = crate::download::SegmentedDownload {
        urls: candidates,
        part_path: part_path.clone(),
        expected_size,
        cancel: &|| is_cancel_requested(app),
        progress: &|done, total| {
            emit_progress(app, version_for_progress.clone(), done, total);
        },
    };
    match download.run().await? {
        crate::download::DownloadOutcome::Cancelled => {
            clear_cancel_request(app);
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
        if let Err(e) = verify_signature(
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
    let signature_text = decode_wrapped_b64(signature_b64)?;
    let pubkey_text = decode_wrapped_pubkey()?;

    let pubkey = minisign_verify::PublicKey::from_base64(&pubkey_text)
        .map_err(|e| format!("内置公钥无效: {}", e))?;
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
}
