use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

use crate::config::settings::NotificationSettings;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationKind {
    AgentApproval,
    AgentTaskDone,
    AgentTaskFailed,
}

impl NotificationKind {
    fn enabled(&self, ns: &NotificationSettings) -> bool {
        match self {
            Self::AgentApproval => ns.agent_approval,
            Self::AgentTaskDone => ns.agent_task_done,
            Self::AgentTaskFailed => ns.agent_task_failed,
        }
    }
}

pub fn send_notification(
    app: &AppHandle,
    kind: NotificationKind,
    ns: &NotificationSettings,
    title: &str,
    body: &str,
) {
    if !kind.enabled(ns) {
        return;
    }
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        log::warn!("发送通知失败: {}", e);
    }
}
