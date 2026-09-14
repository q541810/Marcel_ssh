package com.marcel.ssh

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.Display
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File

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
     * 目标帧率（Hz）：作为 `preferredRefreshRate` 的软提示值，实际落点由
     * `preferredDisplayModeId` 指向「同分辨率下刷新率最高的 mode」决定。
     * 系统只会在设备/电池/温度允许时满足，请求 ≠ 强制。
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
   * 只用公开 SDK 能表达的机制：`preferredRefreshRate`（软提示）+ 
   * `preferredDisplayModeId`（明确落到同物理分辨率下刷新率最高的 display mode）。
   *
   * **为什么不用 `Window.setFrameRate`**：它不在公开 SDK 里。android-34 / 36 的
   * `android.jar` 中 `Window` 没有这个方法，`WindowManager.LayoutParams.FRAME_RATE_COMPATIBILITY_*`
   * 同样不存在（那是 @hide/@SystemApi；公开的只有 `Surface.setFrameRate`，而
   * WebView 的 Surface 不由我们持有）。按 setFrameRate 写会让 release 的 Kotlin
   * 编译直接失败（`Unresolved reference`），整个安卓包编不出来。
   *
   * 代价：`preferredDisplayModeId` 是把窗口钉在某个 mode 上，系统不会像 frame-rate
   * vote 那样按电量/温度动态降档；设备没有更高刷的同分辨率 mode 时什么都不做，
   * 保持系统默认行为。
   */
  private fun requestHighRefreshRate() {
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
      if (best == null || best.refreshRate <= current.refreshRate + 0.5f) {
        Log.i(
          TAG,
          "requestHighRefreshRate: no higher refresh rate mode available (current=${current.refreshRate}Hz)",
        )
        return
      }
      val params = window.attributes
      // 软提示 + 明确落点：前者给会按偏好值挑 mode 的设备，后者保证真的切过去
      params.preferredRefreshRate = TARGET_REFRESH_RATE_HZ
      params.preferredDisplayModeId = best.modeId
      window.attributes = params
      Log.i(
        TAG,
        "requestHighRefreshRate: ${current.refreshRate}Hz → ${best.refreshRate}Hz (modeId=${best.modeId})",
      )
    } catch (e: Throwable) {
      Log.w(TAG, "requestHighRefreshRate failed: ${e.message}")
    }
  }

  // ---------- 应用内更新（由 Rust 侧 JNI 调用） ----------
  //
  // 调用方：src-tauri/src/updater/install.rs 的 `call_activity`
  // （方法签名固定为 `()Ljava/lang/String;` 或
  // `(Ljava/lang/String;)Ljava/lang/String;`）。返回字符串而不是抛异常 ——
  // JNI 里抛出的异常会成为 pending exception，让后续 JNI 调用处于非法状态；
  // Rust 侧只按返回值分支。

  /**
   * 是否已允许本应用安装未知来源的应用（Android 8+ 需用户手动授权；
   * 低版本默认允许）。
   */
  private fun canInstallPackages(): Boolean {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      packageManager.canRequestPackageInstalls()
    } else {
      true
    }
  }

  /**
   * 当前网络是否为计量网络（移动数据/计费热点）。
   *
   * Rust 侧据此决定要不要自动后台下载几十 MB 的安装包：非 "unmetered"
   * （含查询失败 "unknown"）一律按计量网络处理，不自动下载，用户仍可在
   * 设置页手动触发。
   */
  fun networkMetered(): String {
    return try {
      val cm = getSystemService(ConnectivityManager::class.java) ?: return "unknown"
      if (cm.isActiveNetworkMetered) "metered" else "unmetered"
    } catch (e: Exception) {
      Log.w(TAG, "networkMetered 查询失败: ${e.message}")
      "unknown"
    }
  }

  /**
   * 把已下载的 APK 交给系统安装器（用户在系统界面确认安装，装完由系统
   * 重启应用）。系统会强制校验「新包签名 == 已装版本签名」与版本号递增。
   *
   * 返回值：
   * - `started`：已拉起系统安装界面；
   * - `need_permission`：尚未允许「安装未知应用」，此处顺带打开授权页；
   * - `error:...`：失败原因。
   *
   * 传入路径必须是本应用私有 cacheDir 下的文件：由 FileProvider 转成
   * content:// URI 授权给系统安装器读取（`res/xml/file_paths.xml` 的
   * `cache-path "."` 已覆盖整个 cacheDir，含更新器使用的 update/ 子目录）。
   */
  fun installUpdateApk(path: String): String {
    return try {
      val apk = File(path)
      if (!apk.exists()) return "error:安装包不存在（可能已被系统清理）"
      if (!canInstallPackages()) {
        openUnknownSourcesSettings()
        return "need_permission"
      }
      val uri: Uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", apk)
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      // startActivity 必须在主线程执行，而 JNI 调用来自 Rust 的后台线程。
      Handler(Looper.getMainLooper()).post {
        try {
          startActivity(intent)
        } catch (e: Exception) {
          Log.e(TAG, "拉起系统安装器失败: ${e.message}")
        }
      }
      "started"
    } catch (e: Exception) {
      Log.e(TAG, "installUpdateApk 失败: ${e.message}")
      "error:${e.message ?: "未知错误"}"
    }
  }

  /** 打开「安装未知应用」授权页；用户授权后返回应用再点一次「立即安装」。 */
  private fun openUnknownSourcesSettings() {
    try {
      val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
        data = Uri.parse("package:$packageName")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      Handler(Looper.getMainLooper()).post { startActivity(intent) }
    } catch (e: Exception) {
      Log.w(TAG, "打开未知来源授权页失败: ${e.message}")
    }
  }
}
