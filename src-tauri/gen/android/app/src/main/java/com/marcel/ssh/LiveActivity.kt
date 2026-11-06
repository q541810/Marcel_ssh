package com.marcel.ssh

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import org.json.JSONObject

/**
 * 实时活动（状态栏胶囊 / 灵动岛 / 超级岛）：Agent 干活或等确认时挂一条常驻通知，
 * 请求 Android 16 把它「提升」为实时活动。
 *
 * - 标准路径：通知 extras 带 `android.requestPromotedOngoing`，系统（Pixel 胶囊、
 *   HyperOS 3.1+ 超级岛、ColorOS 16 流体云、MagicOS 10 灵动胶囊）自己决定怎么显示。
 *   提升只检查通知本身、渠道重要度和 `POST_PROMOTED_NOTIFICATIONS`，不看 targetSdk。
 * - 小米：系统放行本应用时再附上焦点通知模板（[XiaomiFocus]）。
 * - 其他厂商的私有协议都要白名单 / 认证，侧载 APK 走不通，不写。
 *
 * 只在系统真会提升时才发（[support] 为 ready）；否则什么都不发，免得白多一条常驻通知。
 * 内容由前端 `lib/liveActivity.ts` 归约、`mobile/liveActivitySync.ts` 节流后推来，这里只管发。
 * 通知带 [TIMEOUT_MS] 超时：前端会周期重推，页面被冻结 / 进程死了就由超时收掉，
 * 不会把「干活中」永远留在状态栏。
 */
object LiveActivity {
    const val CHANNEL = "marcel_live"
    const val NOTIFICATION_ID = 3

    /** `Notification.EXTRA_REQUEST_PROMOTED_ONGOING`（SDK 36.1 才公开，写字面量）。 */
    private const val EXTRA_REQUEST_PROMOTED_ONGOING = "android.requestPromotedOngoing"

    /** `Settings.ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS`（同上，字面量）。 */
    private const val ACTION_PROMOTION_SETTINGS = "android.settings.APP_NOTIFICATION_PROMOTION_SETTINGS"

    /** 须明显长于前端的重推周期（4 分钟）。 */
    private const val TIMEOUT_MS = 10 * 60 * 1000L

    const val SUPPORT_READY = "ready"
    const val SUPPORT_NEEDS_ENABLE = "needsEnable"
    const val SUPPORT_UNSUPPORTED = "unsupported"

    /** 前端推来的内容（字段与 `LiveActivityContent` 一一对应）。 */
    data class Content(
        val kind: String,
        val chip: String,
        val title: String,
        val text: String,
        /** 计时起点（epoch 毫秒）；null = 不计时。 */
        val since: Long?,
    ) {
        companion object {
            fun parse(json: String): Content? = runCatching {
                val o = JSONObject(json)
                val title = o.optString("title").ifBlank { "Marcel SSH" }
                Content(
                    kind = o.optString("kind", "running"),
                    chip = o.optString("chip").ifBlank { title },
                    title = title,
                    text = o.optString("text"),
                    since = if (o.isNull("since")) null else o.optLong("since").takeIf { it > 0 },
                )
            }.getOrNull()
        }
    }

    /** 这台手机能不能显示：ready / needsEnable / unsupported。可能有 binder 调用，别在主线程调。 */
    fun support(ctx: Context): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return SUPPORT_UNSUPPORTED
        if (canPromote(ctx) || XiaomiFocus.allowed(ctx)) return SUPPORT_READY
        // 系统有「提升」这个功能但没放行本应用：能解析到放行页才算（旧系统 / 把功能编译掉的
        // ROM 解析不到，那种机器去开启也没有开关，如实说不支持）。
        if (Build.VERSION.SDK_INT >= 36 && promotionSettingsIntent(ctx).resolveActivity(ctx.packageManager) != null) {
            return SUPPORT_NEEDS_ENABLE
        }
        return SUPPORT_UNSUPPORTED
    }

    /** `canPostPromotedNotifications()`：Android 16 QPR1+，且用户没在系统里关掉本应用。 */
    private fun canPromote(ctx: Context): Boolean {
        if (Build.VERSION.SDK_INT < 36) return false
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return false
        // 反射：该方法随 SDK 小版本公开，编译期不依赖它，旧系统上也安全返回 false。
        return runCatching {
            NotificationManager::class.java.getMethod("canPostPromotedNotifications").invoke(nm) as? Boolean
        }.getOrNull() == true
    }

    fun show(ctx: Context, json: String) {
        val c = Content.parse(json) ?: return
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
        if (!nm.areNotificationsEnabled()) return
        if (support(ctx) != SUPPORT_READY) return
        ensureChannel(nm)
        try {
            nm.notify(NOTIFICATION_ID, build(ctx, c))
        } catch (e: SecurityException) {
            android.util.Log.w("LiveActivity", "notify 失败(权限): ${e.message}")
        } catch (e: Exception) {
            android.util.Log.w("LiveActivity", "notify 失败: ${e.message}")
        }
    }

    fun clear(ctx: Context) {
        ctx.getSystemService(NotificationManager::class.java)?.cancel(NOTIFICATION_ID)
    }

    private fun build(ctx: Context, c: Content): Notification {
        val builder = Notification.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(c.title)
            .setContentText(c.text)
            .setContentIntent(MarcelForegroundService.buildLaunchAppIntent(ctx))
            .setCategory(Notification.CATEGORY_PROGRESS)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setLocalOnly(true)
            .setTimeoutAfter(TIMEOUT_MS)
            // 锁屏隐藏敏感内容时只显示泛化文字：对话标题和正文可能含命令 / 主机信息。
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(publicVersion(ctx, c))
            .addExtras(Bundle().apply { putBoolean(EXTRA_REQUEST_PROMOTED_ONGOING, true) })

        if (c.since != null) {
            builder.setWhen(c.since).setShowWhen(true).setUsesChronometer(true)
        } else {
            builder.setShowWhen(false)
        }
        if (Build.VERSION.SDK_INT >= 36) builder.setShortCriticalText(c.chip)

        // 小米：系统放行本应用时才附焦点通知模板（allowed 里有 60 秒缓存，不会每次都走 binder）。
        XiaomiFocus.apply(builder, ctx, c, Icon.createWithResource(ctx, R.mipmap.ic_launcher))
        return builder.build()
    }

    private fun publicVersion(ctx: Context, c: Content): Notification =
        Notification.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Marcel SSH")
            .setContentText(if (c.kind == "waiting") "等你确认" else "Agent 正在干活")
            .build()

    private fun ensureChannel(nm: NotificationManager) {
        if (nm.getNotificationChannel(CHANNEL) != null) return
        // 默认重要度：HyperOS 焦点路径上没被提升时，仍保留状态栏图标；不响铃不振动。
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "实时活动", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Agent 干活或等你确认时，显示在状态栏胶囊 / 灵动岛 / 超级岛"
                setShowBadge(false)
                setSound(null, null)
                enableVibration(false)
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            },
        )
    }

    private fun promotionSettingsIntent(ctx: Context): Intent =
        Intent(ACTION_PROMOTION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /** 跳到系统里放行本应用的页面；打不开就退回通知设置。 */
    fun openSettings(ctx: Context) {
        val fallback = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            ctx.startActivity(promotionSettingsIntent(ctx))
        } catch (_: ActivityNotFoundException) {
            runCatching { ctx.startActivity(fallback) }
        } catch (_: SecurityException) {
            runCatching { ctx.startActivity(fallback) }
        }
    }
}
