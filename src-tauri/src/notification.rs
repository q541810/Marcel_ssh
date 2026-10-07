use tauri::AppHandle;
// Windows 桌面走 show_toast（直连 winrt，见下），用不到插件的 builder 扩展
#[cfg(any(mobile, all(desktop, not(windows))))]
use tauri_plugin_notification::NotificationExt;

#[cfg(mobile)]
use crate::config::settings::MobileNotificationSettings;
use crate::config::settings::NotificationSettings;
#[cfg(desktop)]
use crate::emit_event;

/// 移动端 App 是否在前台。默认 true（启动即前台），由前端 visibilitychange
/// 与 RunEvent::Resumed 同步；前台时不发系统通知（用户已在 App 内可见结果）。
#[cfg(mobile)]
static APP_IN_FOREGROUND: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// 同步移动端前后台状态（仅影响是否发 Agent 系统通知）。
#[cfg(mobile)]
pub fn set_app_in_foreground(in_foreground: bool) {
    APP_IN_FOREGROUND.store(in_foreground, std::sync::atomic::Ordering::Relaxed);
    log::info!("[notification] app_in_foreground={}", in_foreground);
}

#[cfg(mobile)]
fn is_app_in_foreground() -> bool {
    APP_IN_FOREGROUND.load(std::sync::atomic::Ordering::Relaxed)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum NotificationKind {
    AgentApproval,
    AgentQuestion,
    AgentTaskDone,
    AgentTaskFailed,
}

impl NotificationKind {
    #[cfg(desktop)]
    fn enabled(&self, ns: &NotificationSettings) -> bool {
        match self {
            Self::AgentApproval => ns.agent_approval,
            Self::AgentQuestion => ns.agent_question,
            Self::AgentTaskDone => ns.agent_task_done,
            Self::AgentTaskFailed => ns.agent_task_failed,
        }
    }

    #[cfg(mobile)]
    fn enabled_mobile(&self, ns: &MobileNotificationSettings) -> bool {
        match self {
            Self::AgentApproval => ns.agent_approval,
            Self::AgentQuestion => ns.agent_question,
            Self::AgentTaskDone => ns.agent_task_done,
            Self::AgentTaskFailed => ns.agent_task_failed,
        }
    }

    /// 通知 ID（按事件类型固定），同类型后到的覆盖先到的。
    #[cfg(mobile)]
    fn notification_id(&self) -> i32 {
        match self {
            Self::AgentApproval => 100,
            Self::AgentQuestion => 101,
            Self::AgentTaskDone => 102,
            Self::AgentTaskFailed => 103,
        }
    }
}

/// Agent 事件通知的 Android channel id（与 MarcelForegroundService.CHANNEL_AGENT 一致）。
/// 该 channel 在 App 启动时由 MainActivity.onCreate → MarcelForegroundService.createChannels 创建：
/// IMPORTANCE_HIGH（弹横幅）+ 振动 + 无声。
#[cfg(mobile)]
const AGENT_CHANNEL_ID: &str = "marcel_agent";

/// 发送 Agent 事件通知。
///
/// 桌面端：tauri-plugin-notification（系统通知）+ emit `notification-sound` 事件（前端播提示音）。
/// 移动端：仅在 **App 后台** 时发送（前台用户已在界面内看到结果，不弹系统通知）。
///         tauri-plugin-notification 的 Rust API 直接发通知（Rust → JNI → NotificationManager），
///         走 `marcel_agent` channel（IMPORTANCE_HIGH + 振动、无声），不依赖 WebView JS 引擎。
///         不播提示音，配置用独立的 MobileNotificationSettings（不参与云端同步）。
/// Windows 系统通知：直接走 tauri-winrt-notification——tauri-plugin-notification
/// 没有暴露点击激活钩子，而「点击弹窗回到应用」必须挂 Toast 的 Activated 事件。
/// AUMID 条件与插件的 desktop 实现逐字一致（desktop.rs 的 show()）：安装版用
/// config identifier；target/debug|release 下回落 PowerShell 身份（未注册的
/// AUMID 系统会直接拒发 toast）。
#[cfg(all(desktop, windows))]
pub(crate) fn show_toast<R: tauri::Runtime>(app: &tauri::AppHandle<R>, title: &str, body: &str) {
    use tauri::Manager;

    const SEP: char = std::path::MAIN_SEPARATOR;
    let in_target = std::env::current_exe().ok().and_then(|exe| {
        let dir = exe.parent()?.to_str()?;
        Some(
            dir.ends_with(format!("{SEP}target{SEP}debug").as_str())
                || dir.ends_with(format!("{SEP}target{SEP}release").as_str()),
        )
    });
    // current_exe 拿不到的极端情况按安装版处理：identifier 未注册时 toast 发不出、
    // 走 warn 日志，比静默换身份更能暴露问题。
    let app_id: String = match in_target {
        Some(false) => app.config().identifier.clone(),
        _ => tauri_winrt_notification::Toast::POWERSHELL_APP_ID.to_string(),
    };

    let app_for_click = app.clone();
    let title = title.to_string();
    let body = body.to_string();
    // show() 里有 COM 调用，挪到异步运行时线程，调用方（可能是 tokio worker）不等它
    tauri::async_runtime::spawn(async move {
        if let Err(e) = tauri_winrt_notification::Toast::new(&app_id)
            .title(&title)
            .text1(&body)
            .on_activated(move |_action| {
                // 点击 toast 正文：把主窗口拉回前台（最小化则先还原）
                if let Some(window) = app_for_click.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                Ok(())
            })
            .show()
        {
            log::warn!("发送 Windows 通知失败: {e}");
        }
    });
}

pub fn send_notification(
    app: &AppHandle,
    kind: NotificationKind,
    ns: &NotificationSettings,
    title: &str,
    body: &str,
) {
    #[cfg(mobile)]
    {
        send_notification_mobile(app, kind, title, body);
        let _ = ns; // 桌面端专用参数，移动端忽略
    }
    #[cfg(desktop)]
    {
        if !kind.enabled(ns) {
            return;
        }
        #[cfg(windows)]
        show_toast(app, title, body);
        #[cfg(not(windows))]
        if let Err(e) = app.notification().builder().title(title).body(body).show() {
            log::warn!("发送通知失败: {}", e);
        }
        emit_event(app, "notification-sound", kind);
    }
}

#[cfg(mobile)]
fn send_notification_mobile(app: &AppHandle, kind: NotificationKind, title: &str, body: &str) {
    use tauri::Manager;

    // 前台不发系统通知：审批/提问/完成结果已在 Agent UI 内可见。
    if is_app_in_foreground() {
        log::debug!("[notification] App 在前台，跳过系统通知: kind={:?}", kind);
        return;
    }

    // 读移动端独立通知设置（不参与云端同步，与桌面端隔离）
    // 注意：send_notification 被 agent_loop 等异步上下文调用，不能用 blocking_read()，
    // 否则 tokio worker 线程阻塞会 panic（"Cannot block the current thread from within a runtime"）。
    // try_read() 非阻塞，拿不到锁（极少数情况）就跳过本次通知，避免 panic。
    let mobile_ns = match app.state::<crate::AppState>().settings.try_read() {
        Ok(guard) => guard.mobile_notification_settings.clone(),
        Err(_) => {
            log::warn!("[notification] 设置锁被占用，跳过本次通知: kind={:?}", kind);
            return;
        }
    };
    if !kind.enabled_mobile(&mobile_ns) {
        log::debug!("[notification] 事件 {:?} 被移动端设置关闭，跳过", kind);
        return;
    }

    let notification_id = kind.notification_id();
    log::info!(
        "[notification] 准备发送 Agent 通知: id={}, kind={:?}, title={}",
        notification_id,
        kind,
        title
    );

    // 路径 1：tauri-plugin-notification（Rust → JNI → PluginManager → NotificationManager）
    // 不依赖 WebView JS 引擎，前台服务保活下后台可靠触发。
    // channel 由 MainActivity.onCreate 调 createChannels 提前创建。
    //
    // 关键：show() 内部调 run_mobile_plugin → std::sync::mpsc::rx.recv() 阻塞等待 JNI 响应，
    // 直接在 tokio worker 线程调会 panic ("Cannot block the current thread from within a runtime")。
    // 用 tauri::async_runtime::spawn_blocking 把阻塞调用挪到专用线程池，fire-and-forget，
    // 调用方不需要等通知发送完成。
    let app_clone = app.clone();
    let title_owned = title.to_string();
    let body_owned = body.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        match app_clone
            .notification()
            .builder()
            .id(notification_id)
            .channel_id(AGENT_CHANNEL_ID)
            .title(&title_owned)
            .body(&body_owned)
            .auto_cancel()
            .show()
        {
            Ok(()) => log::info!(
                "[notification] 路径1(plugin) 通知发送成功: id={}",
                notification_id
            ),
            Err(e) => log::error!("[notification] 路径1(plugin) 发送失败: {}", e),
        }
    });

    // 路径 2：AndroidBridge + webview.eval（派发到 MarcelForegroundService）
    // 后台时 WebView 可能已冻结，eval 可能延迟或丢弃；路径 1 是可靠主路径。
    // 与路径 1 用相同 notification_id，后到的覆盖先到的，用户最多看到一条。
    let title_json = serde_json::to_string(title).unwrap_or_else(|_| "\"\"".to_string());
    let body_json = serde_json::to_string(body).unwrap_or_else(|_| "\"\"".to_string());
    let js = format!(
        "try{{window.AndroidBridge&&window.AndroidBridge.sendAgentNotification({id},{title},{body})}}catch(e){{}}",
        id = notification_id,
        title = title_json,
        body = body_json,
    );
    for (_label, webview) in app.webviews() {
        let _: Result<(), _> = webview.eval(&js);
    }
    log::info!(
        "[notification] 路径2(bridge) 已派发: id={}",
        notification_id
    );
}
