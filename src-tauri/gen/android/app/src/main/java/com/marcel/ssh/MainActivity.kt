package com.marcel.ssh

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Display
import android.view.ViewGroup
import android.view.WindowManager
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
  /** Last system navigation bar height (physical px) pushed to the page. */
  private var lastNavBottomPx: Int = -1

  /** 注入 WebView 的原生桥接对象（window.AndroidBridge）。 */
  private val mobileBridge by lazy { MobileBridge(this) }

  companion object {
    const val REQUEST_NOTIFICATION_PERMISSION = 1001
    private const val TAG = "MarcelMainActivity"
    /**
     * 目标帧率（Hz）。Android 11+ 用 Window.setFrameRate 请求；
     * 低版本用 preferredDisplayModeId 在同分辨率下挑刷新率最高的 mode。
     * 系统只会在电池/温度允许时满足请求，请求 ≠ 强制。
     */
    private const val TARGET_REFRESH_RATE_HZ = 120f
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    // 冷启动画面由 Theme.marcel_ssh.Splash 的 windowBackground（深色纯色背景）
    // 提供：系统在 Activity 首帧绘制前展示它，无需 AndroidX SplashScreen API
    // （core-splashscreen 的 api-stub Kotlin 元数据有缺陷，编译无法通过）。
    // WebView 自身背景设为深色（onWebViewCreate），覆盖 HTML 解析前的窗口，
    // 保证 splash → WebView → React 全程深色无白屏。
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // 申请高刷新率显示模式（120Hz 及以上），让 WebView 跟着跑满。
    // 必须在 super.onCreate 之后、setContentView 之前调用，参数才生效。
    // 仅当设备实际支持时才设置，避免无效日志骚扰。
    requestHighRefreshRate()

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
    // HTML 解析完成前 WebView 是白底：设为 zinc-950（与 windowBackground /
    // index.html / React UI 一致），消除 splash 消失到页面首帧之间的白闪。
    webView.setBackgroundColor(0xFF09090B.toInt())

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
    // The same applies to the system navigation bar (3-button nav): Android
    // WebView's env(safe-area-inset-bottom) only reflects the display cutout,
    // NOT the navigation bar, so edge-to-edge would leave bottom-anchored UI
    // (tab bar, sheets, fullscreen pages) buried under the 3-button bar. We
    // publish the navigation bar height as --nav-bar-bottom so the page can
    // max() it into the same bottom padding. When the IME opens it covers the
    // navigation bar (navigationBars() insets go to 0), so the two variables
    // never stack.
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
        val navBottom =
          insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom
        if (navBottom != lastNavBottomPx) {
          lastNavBottomPx = navBottom
          val density = webView.resources.displayMetrics.density
          val cssPx =
            if (density > 0f) navBottom / density else navBottom.toFloat()
          val cssValue =
            if (cssPx == cssPx.toInt().toFloat()) "${cssPx.toInt()}px" else "${cssPx}px"
          webView.evaluateJavascript(
            "document.documentElement.style.setProperty('--nav-bar-bottom','$cssValue')",
            null,
          )
        }
        insets
      }
      // Seed 0 so the page has a defined variable even before the first
      // non-zero dispatch.
      if (lastImeBottomPx < 0) {
        lastImeBottomPx = 0
        webView.evaluateJavascript(
          "document.documentElement.style.setProperty('--ime-bottom','0px')",
          null,
        )
      }
      if (lastNavBottomPx < 0) {
        lastNavBottomPx = 0
        webView.evaluateJavascript(
          "document.documentElement.style.setProperty('--nav-bar-bottom','0px')",
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

  /**
   * 申请最高可用刷新率（120Hz），让 WebView 也跑满。
   *
   * - API 31+（Android 12+）：用 Window.setFrameRate，是官方推荐方式，行为最干净：
   *   系统在电池/温度允许时会提升到 120Hz，不需要时回落，不锁死。
   * - API 23-30：setFrameRate 不可用，退回 WindowManager.LayoutParams.preferredDisplayModeId，
   *   在同物理分辨率下挑刷新率最高的 mode（避免被切到低分辨率的 Hi-Fi 模式）。
   * - 设备/系统不支持目标刷新率：直接 return，不报错也不影响默认行为。
   * - 必须先于 onCreate 完成前的窗口附加阶段调用一次，且在 WebView 首次绘制时仍然有效
   *   （系统按窗口 frame rate 决定 display 模式，与 WebView 内部 setRenderPriority 无关）。
   */
  private fun requestHighRefreshRate() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      try {
        // FRAME_RATE_COMPATIBILITY_DEFAULT：请求但不强制（系统会按需降级）
        window.setFrameRate(
          TARGET_REFRESH_RATE_HZ,
          WindowManager.LayoutParams.FRAME_RATE_COMPATIBILITY_DEFAULT,
        )
        Log.i(TAG, "requestHighRefreshRate: setFrameRate(${TARGET_REFRESH_RATE_HZ}Hz)")
      } catch (e: Throwable) {
        Log.w(TAG, "requestHighRefreshRate: setFrameRate failed: ${e.message}")
      }
      return
    }

    // API 23-30：preferredDisplayModeId 路径
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
    try {
      val display: Display = windowManager.defaultDisplay ?: return
      val current = display.mode
      var best: Display.Mode? = null
      for (mode in display.supportedModes) {
        // 只在同物理分辨率下挑刷新率最高的，避免被切到低分辨率的「流畅」模式
        if (mode.physicalWidth != current.physicalWidth) continue
        if (mode.physicalHeight != current.physicalHeight) continue
        if (best == null || mode.refreshRate > best.refreshRate) best = mode
      }
      if (best != null && best.refreshRate > current.refreshRate + 0.5f) {
        val params = window.attributes
        params.preferredDisplayModeId = best.modeId
        window.attributes = params
        Log.i(
          TAG,
          "requestHighRefreshRate: ${current.refreshRate}Hz → ${best.refreshRate}Hz (modeId=${best.modeId})",
        )
      } else {
        Log.i(TAG, "requestHighRefreshRate: no higher refresh rate mode available (current=${current.refreshRate}Hz)")
      }
    } catch (e: Throwable) {
      Log.w(TAG, "requestHighRefreshRate: preferredDisplayModeId failed: ${e.message}")
    }
  }
}
