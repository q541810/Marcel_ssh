package com.marcel.ssh

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.webkit.JavascriptInterface
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * 注入 WebView 的 Java/Kotlin 桥接对象（`window.AndroidBridge`）。
 *
 * 前端通过 `src/mobile/mobileBridge.ts` 封装后调用，所有方法都跑在 WebView 的 JS 线程，
 * 涉及 UI/权限的操作切回主线程执行。
 *
 * 设计权衡：用 `@JavascriptInterface` 而非 Tauri mobile plugin，避免独立 crate 工程量。
 * 安全注意：只暴露保活/通知相关方法，不暴露任意命令执行能力。
 */
class MobileBridge(private val activity: MainActivity) {

    // ---------- 前台保活服务 ----------

    /** 启动前台保活服务（幂等：已运行则更新通知）。 */
    @JavascriptInterface
    fun startForegroundService(title: String, body: String) {
        MarcelForegroundService.createChannels(activity)
        MarcelForegroundService.start(activity, title.ifBlank { "Marcel SSH" }, body.ifBlank { "运行中" })
    }

    /** 停止前台保活服务。 */
    @JavascriptInterface
    fun stopForegroundService() {
        MarcelForegroundService.stop(activity)
    }

    /** 更新常驻通知内容（服务必须已启动）。 */
    @JavascriptInterface
    fun updateForegroundNotification(title: String, body: String) {
        MarcelForegroundService.update(activity, title, body)
    }

    // ---------- Agent 事件通知 ----------

    /**
     * 发送 Agent 事件通知（审批/提问/任务完成/失败）。
     * 通过 startService Intent 派发给 MarcelForegroundService，由 Service 直接调 NotificationManager，
     * 不依赖 WebView JS 引擎活跃，前台后台均可靠。
     *
     * @param id 通知 ID（同类型事件用相同 ID，后到的覆盖先到的）
     */
    @JavascriptInterface
    fun sendAgentNotification(id: Int, title: String, body: String) {
        android.util.Log.i("MarcelBridge", "sendAgentNotification: id=$id title=$title")
        MarcelForegroundService.notifyAgentEvent(activity, id, title, body)
    }

    // ---------- 通知权限 ----------

    /** 检查 POST_NOTIFICATIONS 权限（API 33+ 需运行时权限，更低版本默认授予）。 */
    @JavascriptInterface
    fun isNotificationPermissionGranted(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(
                activity,
                Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
        } else {
            true
        }
    }

    /**
     * 请求 POST_NOTIFICATIONS 权限。异步：弹出系统权限对话框。
     * 结果通过 `window.__marcelNotificationPermissionResult(granted: boolean)` 回调通知前端。
     */
    @JavascriptInterface
    fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            // 低版本无需请求，直接通知前端已授予
            activity.runOnUiThread {
                activity.notifyPermissionResult(true)
            }
            return
        }
        if (isNotificationPermissionGranted()) {
            activity.runOnUiThread { activity.notifyPermissionResult(true) }
            return
        }
        activity.runOnUiThread {
            ActivityCompat.requestPermissions(
                activity,
                arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                MainActivity.REQUEST_NOTIFICATION_PERMISSION
            )
        }
    }
}
