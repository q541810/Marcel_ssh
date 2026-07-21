package com.marcel.ssh

import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var webViewRef: WebView? = null
  /** Last IME height (physical px) pushed to the page — skip no-op updates. */
  private var lastImeBottomPx: Int = -1

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

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
          // evaluateJavascript JSON-encodes the JS return value; a boolean
          // arrives as "true"/"false" (possibly quoted on older WebViews).
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

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webViewRef = webView
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
}
