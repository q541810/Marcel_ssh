package com.marcel.ssh

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var webViewRef: WebView? = null
  /** Last IME height (physical px) pushed to the page — skip no-op updates. */
  private var lastImeBottomPx: Int = -1

  /** 注入 WebView 的原生桥接对象（window.AndroidBridge）。 */
  private val mobileBridge by lazy { MobileBridge(this) }

  companion object {
    const val REQUEST_NOTIFICATION_PERMISSION = 1001
    private const val TAG = "MarcelMainActivity"
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // 提前创建通知通道：即使前台服务未启动，Agent 事件通知也需要通道已存在。
    // 直接内联在 MainActivity，避免依赖 MarcelForegroundService.kt 是否被编译。
    createNotificationChannelsInline()
    // 同时调 Service 的 createChannels（幂等，双保险，确保 Service 类被加载）
    MarcelForegroundService.createChannels(this)
    verifyChannels()

    // Give the web layer first crack at the back gesture: sheets, overlays and
    // sub-pages register close callbacks in `window.__marcelHandleBack`
    // (src/mobile/backHandler.ts). If nothing consumes it there, fall through
    // to the system default (finish the activity).
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val webView = webViewRef
        if (webView == null) {
          passThrough()
          return
        }
        webView.evaluateJavascript(
          "window.__marcelHandleBack ? window.__marcelHandleBack() : false"
        ) { result ->
          val consumed = result?.trim('"') == "true"
          if (!consumed) {
            passThrough()
          }
        }
      }

      private fun passThrough() {
        isEnabled = false
        onBackPressedDispatcher.onBackPressed()
        isEnabled = true
      }
    })
  }

  /**
   * 内联创建通知通道（不依赖 MarcelForegroundService.kt 是否被编译进 APK）。
   * Agent 通知：IMPORTANCE_HIGH（弹横幅）+ enableVibration(true) + 无声 + 锁屏可见。
   * 常驻通知：IMPORTANCE_LOW（无声无振动）。
   */
  private fun createNotificationChannelsInline() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      Log.w(TAG, "SDK<26，跳过 channel 创建")
      return
    }
    val manager = getSystemService(NotificationManager::class.java)
    if (manager == null) {
      Log.e(TAG, "NotificationManager 为 null，无法创建 channel")
      return
    }

    // 常驻通知
    val serviceChannel = NotificationChannel(
      "marcel_service",
      "Marcel SSH 运行状态",
      NotificationManager.IMPORTANCE_LOW
    ).apply {
      description = "前台保活服务的常驻通知"
      setShowBadge(false)
      setSound(null, null)
      enableVibration(false)
      lockscreenVisibility = Notification.VISIBILITY_PRIVATE
    }

    // Agent 事件通知
    val agentChannel = NotificationChannel(
      "marcel_agent",
      "Agent 通知",
      NotificationManager.IMPORTANCE_HIGH
    ).apply {
      description = "Agent 审批、提问、任务完成与失败通知（振动提醒，无声）"
      setSound(null, null)
      enableVibration(true)
      lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    }

    manager.createNotificationChannels(listOf(serviceChannel, agentChannel))
    Log.i(TAG, "createNotificationChannelsInline 完成: marcel_agent IMPORTANCE_HIGH+vibration+public")
  }

  /**
   * 验证 channel 实际配置（用于排查系统设置显示与代码不符的问题）。
   * 读回 channel 的 importance/vibration/visibility 并打日志。
   */
  private fun verifyChannels() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NotificationManager::class.java) ?: return
    val agent = manager.getNotificationChannel("marcel_agent")
    if (agent == null) {
      Log.e(TAG, "verifyChannels: marcel_agent channel 不存在！")
      return
    }
    Log.i(TAG, "verifyChannels marcel_agent: id=${agent.id} name=${agent.name} " +
      "importance=${agent.importance}(HIGH=4) " +
      "vibration=${agent.shouldVibrate()} " +
      "sound=${agent.sound} " +
      "visibility=${agent.lockscreenVisibility}(PUBLIC=1) " +
      "showBadge=${agent.canShowBadge()}")
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webViewRef = webView

    // 注入原生桥接对象，前端通过 window.AndroidBridge.* 调用
    // @JavascriptInterface 注解的方法，用于前台保活服务与 Agent 通知
    webView.addJavascriptInterface(mobileBridge, "AndroidBridge")

    // With enableEdgeToEdge the system no longer shrinks the window for the
    // soft keyboard (adjustResize only dispatches WindowInsets). We do NOT
    // resize the WebView either: that would lift the bottom tab bar with the
    // keyboard. Instead we publish the IME height as a CSS variable so the
    // page can pad only the content area and leave the tab bar pinned under
    // the keyboard.
    //
    // Listener must sit on the parent, never on the WebView: a view-level
    // listener replaces View.onApplyWindowInsets, which is how Chromium
    // forwards status bar / nav bar / cutout insets to env(safe-area-inset-*).
    webView.post {
      val parent = webView.parent as? ViewGroup ?: return@post
      ViewCompat.setOnApplyWindowInsetsListener(parent) { _, insets ->
        val imeBottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
        if (imeBottom != lastImeBottomPx) {
          lastImeBottomPx = imeBottom
          // CSS px = physical px / density (matches WebView viewport units).
          val density = webView.resources.displayMetrics.density
          val cssPx = if (density > 0f) imeBottom / density else imeBottom.toFloat()
          // toString() on a clean integer when possible avoids long floats.
          val cssValue =
            if (cssPx == cssPx.toInt().toFloat()) "${cssPx.toInt()}px" else "${cssPx}px"
          webView.evaluateJavascript(
            "document.documentElement.style.setProperty('--ime-bottom','$cssValue')",
            null,
          )
        }
        insets
      }
      // Seed 0 so the page has a defined variable even before the first
      // non-zero IME dispatch.
      if (lastImeBottomPx < 0) {
        lastImeBottomPx = 0
        webView.evaluateJavascript(
          "document.documentElement.style.setProperty('--ime-bottom','0px')",
          null,
        )
      }
    }
  }

  override fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<out String>,
    grantResults: IntArray
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode == REQUEST_NOTIFICATION_PERMISSION) {
      val granted = grantResults.isNotEmpty() &&
        grantResults[0] == PackageManager.PERMISSION_GRANTED
      notifyPermissionResult(granted)
    }
  }

  /**
   * 通过 evaluateJavascript 把通知权限请求结果回传给前端。
   * 前端在 src/mobile/mobileBridge.ts 里监听 window.__marcelNotificationPermissionResult。
   */
  fun notifyPermissionResult(granted: Boolean) {
    webViewRef?.evaluateJavascript(
      "window.__marcelNotificationPermissionResult && window.__marcelNotificationPermissionResult($granted)",
      null
    )
  }
}
