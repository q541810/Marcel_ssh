package com.marcel.ssh

import android.app.Notification
import android.content.Context
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.provider.Settings
import org.json.JSONObject

/**
 * 小米焦点通知 / 超级岛的模板：在实时活动通知上附 `miui.focus.param`（JSON）和图片。
 *
 * 只在系统确认放行本应用时才附（[allowed]）：国行要小米审核上架应用，国际版是用户开关，
 * 侧载 APK 多半拿不到放行。没放行时这些 extras 只是白占字节，所以不加。HyperOS 3.1+ 还会
 * 把标准实时活动（[LiveActivity]）放进超级岛，那条路不需要这里的任何东西。
 */
object XiaomiFocus {
    private const val EXTRA_PARAM = "miui.focus.param"
    private const val EXTRA_PICS = "miui.focus.pics"
    private const val PIC_KEY = "miui.focus.pic_icon"

    private const val PROTOCOL_SETTING = "notification_focus_protocol"
    private const val PROVIDER = "content://miui.statusbar.notification.public"
    private const val CHECK_TTL_MS = 60_000L

    /** 模板上限（UTF-8 字节）。 */
    const val PARAM_MAX_BYTES = 3072

    /** 小岛文字区只放得下约 4 个字，多留一点余量交给系统截断。 */
    private const val ISLAND_CHARS = 6

    @Volatile
    private var checked: Pair<Long, Boolean>? = null

    /** 是不是小米系（含红米、POCO）。 */
    fun isXiaomi(): Boolean {
        val s = "${Build.MANUFACTURER} ${Build.BRAND}".lowercase()
        return s.contains("xiaomi") || s.contains("redmi") || s.contains("poco")
    }

    /**
     * 系统是否显示本应用的焦点通知。含 binder 调用，结果缓存 60 秒；别在主线程调。
     * 非小米机型直接 false，不去碰对方的 ContentProvider。
     */
    fun allowed(ctx: Context): Boolean {
        if (!isXiaomi()) return false
        val now = SystemClock.elapsedRealtime()
        checked?.let { (at, ok) -> if (now - at < CHECK_TTL_MS) return ok }
        val ok = protocol(ctx) >= 1 && canShowFocus(ctx)
        checked = now to ok
        return ok
    }

    /** 1 = HyperOS 1，2 = HyperOS 2，3 = HyperOS 3（超级岛）；读不到记 0。 */
    private fun protocol(ctx: Context): Int =
        runCatching { Settings.System.getInt(ctx.contentResolver, PROTOCOL_SETTING, 0) }.getOrDefault(0)

    private fun canShowFocus(ctx: Context): Boolean = runCatching {
        val extras = Bundle().apply { putString("package", ctx.packageName) }
        ctx.contentResolver.call(Uri.parse(PROVIDER), "canShowFocus", null, extras)
            ?.getBoolean("canShowFocus", false) == true
    }.getOrDefault(false)

    /** 放行时给 [builder] 附上模板和图片；没放行什么都不做。 */
    fun apply(builder: Notification.Builder, ctx: Context, c: LiveActivity.Content, picture: Icon) {
        if (!allowed(ctx)) return
        builder.addExtras(
            Bundle().apply {
                putString(EXTRA_PARAM, param(c))
                putBundle(EXTRA_PICS, Bundle().apply { putParcelable(PIC_KEY, picture) })
            },
        )
    }

    /**
     * 模板：大岛左侧放图标加胶囊短词，小岛只放图标，展开卡片放标题和正文。
     * 超过 [PARAM_MAX_BYTES] 时先把正文、再把标题折半截短，直到装得下。
     */
    fun param(c: LiveActivity.Content): String {
        val word = c.chip.take(ISLAND_CHARS)
        var title = c.title
        var text = c.text
        while (true) {
            val json = template(c, word, title, text).toString()
            if (json.toByteArray(Charsets.UTF_8).size <= PARAM_MAX_BYTES || (title.length <= 8 && text.isEmpty())) {
                return json
            }
            if (text.isNotEmpty()) text = text.take(text.length / 2) else title = title.take(title.length / 2)
        }
    }

    private fun template(c: LiveActivity.Content, word: String, title: String, text: String): JSONObject {
        val pic = JSONObject().put("type", 1).put("pic", PIC_KEY)
        val island = JSONObject()
            .put("islandProperty", 1)
            .put(
                "bigIslandArea",
                JSONObject().put(
                    "imageTextInfoLeft",
                    JSONObject()
                        .put("type", 1)
                        .put("picInfo", pic)
                        .put("textInfo", JSONObject().put("title", word)),
                ),
            )
            .put("smallIslandArea", JSONObject().put("picInfo", pic))
        val v2 = JSONObject()
            .put("protocol", 1)
            .put("business", "marcel_live_${c.kind}")
            .put("updatable", true)
            .put("enableFloat", false)
            .put("ticker", "$word · $title")
            .put("aodTitle", word)
            .put("param_island", island)
            .put("baseInfo", JSONObject().put("type", 2).put("title", title).put("content", text))
        return JSONObject().put("param_v2", v2)
    }
}
