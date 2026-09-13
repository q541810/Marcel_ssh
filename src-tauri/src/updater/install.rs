//! 平台安装动作：把「已下载并校验通过的安装包」真正装上去。
//!
//! 两端能力不同，这是平台决定的，不是实现取舍：
//! - **Windows**：NSIS 支持 `/S` 静默 + `/UPDATE` 更新模式 + `/R` 装完重启，
//!   因此可以做到「退出即自动安装」；安装只发生在应用退出之后（`RunEvent::Exit`）。
//! - **Android**：系统不允许普通应用静默安装 APK，必须由用户在系统安装器界面
//!   确认。因此这里只负责把 `content://` URI 交给系统安装器（`ACTION_VIEW`），
//!   签名一致性与版本递增由系统强制校验；安装结果通过下次启动的版本比对判定
//!   （`cleanup_update_dir` 见到 `version <= current` 即认定装成功并删包）。
//! - **其他桌面平台**：不支持，`update_capabilities` 会关掉入口。

// 平台分支各用一部分导入，按平台分别引入以免非本平台构建出现未使用警告。
#[cfg(windows)]
use std::path::Path;

#[cfg(windows)]
use tauri::Manager;

use tauri::AppHandle;

use super::PendingInstall;
#[cfg(windows)]
use super::UpdaterState;

use crate::error::AppError;

/// 应用退出时安装（Windows 专用）。
///
/// 用 ping 延迟约 2 秒再运行安装器，确保主进程完全退出、NSIS 的
/// `CheckIfAppIsRunning` 不会撞上退出中的进程（该宏在 silent 模式下会直接
/// kill 残留进程，属于兜底而非正常路径）。`/R` 让安装器装完自动启动应用，
/// 实现「立即重启更新」的自动重开。
#[cfg(windows)]
pub(super) fn install_on_exit(app: &AppHandle) {
    let Some(state) = app.try_state::<UpdaterState>() else {
        return;
    };
    let (pending, restart) = {
        let Ok(mut inner) = state.0.lock() else {
            return;
        };
        let Some(pending) = inner.pending.take() else {
            return;
        };
        (pending, inner.restart_after_install)
    };
    log::info!(
        "应用退出，静默安装更新 v{}（重启应用: {}）: {}",
        pending.version,
        restart,
        pending.installer_path.display()
    );
    spawn_installer(&pending.installer_path, restart);
}

/// 「立即安装」：Windows 记录重启标记后退出应用（真正安装由退出钩子完成）；
/// Android 直接把已下载的 APK 交给系统安装器。
pub(super) fn launch_now(
    app: &AppHandle,
    pending: &PendingInstall,
    restart_after_install: bool,
) -> Result<(), AppError> {
    #[cfg(windows)]
    {
        log::info!(
            "用户请求立即安装 v{}，退出并交由安装器处理: {}",
            pending.version,
            pending.installer_path.display()
        );
        let state = app.state::<UpdaterState>();
        {
            let mut inner = state
                .0
                .lock()
                .map_err(|_| AppError::Other("更新器状态被占用".into()))?;
            inner.restart_after_install = restart_after_install;
        }
        // 退出阻塞在事件循环里，退出钩子会接管安装。
        app.exit(0);
        Ok(())
    }
    #[cfg(target_os = "android")]
    {
        let _ = app;
        let _ = restart_after_install; // 安卓安装完由系统重启应用
        let path = pending
            .installer_path
            .to_str()
            .ok_or_else(|| AppError::Other("安装包路径无效".into()))?;
        android::install_apk(path)
    }
    #[cfg(not(any(windows, target_os = "android")))]
    {
        let _ = (app, pending, restart_after_install);
        Err(AppError::Other(
            "当前平台不支持后台自动更新，请前往下载页手动安装".into(),
        ))
    }
}

/// 当前网络是否允许自动下载（Android 只在非计量网络下自动下载，避免在移动
/// 数据上静默消耗几十 MB；手动触发不受此限制）。
///
/// 查询失败时按「计量网络」处理并告警：误自动下载会让用户花流量，而不自动
/// 下载只是少了个便利，用户仍可手动触发。
#[cfg(target_os = "android")]
pub(super) fn is_unmetered_network() -> bool {
    match android::call_activity("networkMetered", None) {
        Ok(status) => status == "unmetered",
        Err(e) => {
            log::warn!("网络计量状态查询失败，按计量网络处理（不自动下载）: {}", e);
            false
        }
    }
}

/// 非 Android 平台没有流量概念。
#[cfg(not(target_os = "android"))]
pub(super) fn is_unmetered_network() -> bool {
    true
}

// ── Windows ─────────────────────────────────────────────────────

#[cfg(windows)]
fn spawn_installer(installer_path: &Path, restart_after_install: bool) {
    use std::os::windows::process::CommandExt as _;
    use std::process::Command;

    // CREATE_NO_WINDOW：隐藏 cmd 与安装器的任何残余 UI
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // /R 仅在用户主动点「立即安装」时带上：装完自动启动应用。
    // 自然退出不带 —— 安装完窗口自己弹出来反而打扰。
    let restart_flag = if restart_after_install { " /R" } else { "" };
    let script = format!(
        "ping -n 3 127.0.0.1 >nul & \"{}\" /S{} /UPDATE",
        installer_path.display(),
        restart_flag
    );
    // 必须用 raw_arg：arg() 会把内部引号转义成 \"，而 cmd 不认反斜杠转义，
    // 会把 \"C:\...exe\" 整段当作命令名（真机实测踩过：静默失败无任何提示）。
    let result = Command::new("cmd")
        .arg("/C")
        .raw_arg(&script)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
    if let Err(e) = result {
        // 安装器拉不起来：放弃本次（pending 已消费，下次启动重新检查下载）
        log::warn!("启动静默安装器失败: {}", e);
    }
}

// ── Android ─────────────────────────────────────────────────────

#[cfg(target_os = "android")]
mod android {
    use jni::objects::{JObject, JString, JValue};
    use jni::JNIEnv;

    use crate::error::AppError;

    /// 调用 MainActivity 上的原生方法（见 `gen/android/.../MainActivity.kt`）。
    ///
    /// 与 `util.rs` 的 content URI 查询同一套惯用法：JNI 失败一律返回 Err，
    /// 不 panic、不留 pending exception（留着会让后续 JNI 调用处于非法状态）。
    /// 入参/返回都用字符串，避免每个方法各写一套签名。
    pub(super) fn call_activity(method: &str, arg: Option<&str>) -> Result<String, String> {
        let ctx = ndk_context::android_context();
        let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
            .map_err(|e| format!("获取 JavaVM 失败: {}", e))?;
        let mut guard = vm
            .attach_current_thread()
            .map_err(|e| format!("attach JVM 线程失败: {}", e))?;
        let env: &mut JNIEnv = &mut guard;
        let activity = unsafe { JObject::from_raw(ctx.context() as jni::sys::jobject) };

        // 闭包内完成「调用 + 取出字符串」，避免把 JNI 局部引用（JString）带出
        // 闭包 —— 它的生命周期绑定在本次 JNI 调用上。
        let call = |env: &mut JNIEnv| -> jni::errors::Result<String> {
            let returned: JObject = match arg {
                Some(value) => {
                    let jarg: JObject = env.new_string(value)?.into();
                    env.call_method(
                        &activity,
                        method,
                        "(Ljava/lang/String;)Ljava/lang/String;",
                        &[JValue::Object(&jarg)],
                    )?
                    .l()?
                }
                None => env
                    .call_method(&activity, method, "()Ljava/lang/String;", &[])?
                    .l()?,
            };
            let jstr = JString::from(returned);
            env.get_string(&jstr)
                .map(|s| s.to_string_lossy().into_owned())
        };

        match call(env) {
            Ok(value) => Ok(value),
            Err(e) => {
                let _ = env.exception_clear();
                Err(format!("调用原生方法 {} 失败: {}", method, e))
            }
        }
    }

    /// 把已下载的 APK 交给系统安装器。
    ///
    /// Kotlin 侧返回状态字符串，这里翻译成用户能看懂的错误：
    /// - `started`：已拉起系统安装界面（用户在系统界面确认安装）；
    /// - `need_permission`：尚未允许「安装未知应用」，Kotlin 已顺带打开授权页；
    /// - 其他：异常信息。
    pub(super) fn install_apk(path: &str) -> Result<(), AppError> {
        match call_activity("installUpdateApk", Some(path)) {
            Ok(status) if status == "started" => Ok(()),
            Ok(status) if status == "need_permission" => Err(AppError::Other(
                "需要先允许「安装未知应用」，已为你打开设置页；授权后返回再点一次「立即安装」"
                    .into(),
            )),
            Ok(other) => Err(AppError::Other(format!("拉起系统安装器失败: {}", other))),
            Err(e) => Err(AppError::Other(format!("拉起系统安装器失败: {}", e))),
        }
    }
}
