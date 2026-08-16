package com.marcel.ssh

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * 前台保活服务：切后台后维持 SSH 会话与 Agent 任务运行。
 *
 * - 常驻通知（CHANNEL_SERVICE，IMPORTANCE_LOW，无声）满足 Android 前台服务硬性要求
 * - 持有 PARTIAL_WAKE_LOCK 防止 CPU 休眠导致 SSH keepalive 发不出去
 * - START_STICKY 让系统在内存压力杀掉后尝试重建
 *
 * Agent 事件通知（审批/提问/完成/失败）走 CHANNEL_AGENT（IMPORTANCE_HIGH 无声，弹横幅），
 * 由 tauri-plugin-notification 或 MobileBridge.sendAgentNotification 发出，与本常驻通知互不干扰。
 */
class MarcelForegroundService : Service() {

    companion object {
        const val CHANNEL_SERVICE = "marcel_service"
        const val CHANNEL_AGENT = "marcel_agent"
        const val NOTIFICATION_ID_SERVICE = 1

        const val ACTION_START = "com.marcel.ssh.action.START"
        const val ACTION_UPDATE = "com.marcel.ssh.action.UPDATE"
        const val ACTION_STOP = "com.marcel.ssh.action.STOP"
        const val ACTION_NOTIFY = "com.marcel.ssh.action.NOTIFY"
        const val ACTION_RESTORE = "com.marcel.ssh.action.RESTORE"
        const val EXTRA_TITLE = "title"
        const val EXTRA_BODY = "body"
        const val EXTRA_NOTIFICATION_ID = "notification_id"

        /**
         * 发送 Agent 事件通知（审批/提问/完成/失败）。
         * 通过 startService Intent 派发，Service 直接调 NotificationManager，
         * 不依赖 WebView JS 引擎，前台后台均可靠。
         *
         * 注意：即使保活服务未启动，也可调用——Service 的 onStartCommand 会处理 NOTIFY action。
         */
        fun notifyAgentEvent(context: Context, id: Int, title: String, body: String) {
            createChannels(context)
            val intent = Intent(context, MarcelForegroundService::class.java).apply {
                action = ACTION_NOTIFY
                putExtra(EXTRA_NOTIFICATION_ID, id)
                putExtra(EXTRA_TITLE, title)
                putExtra(EXTRA_BODY, body)
            }
            // 用 startService 而非 startForegroundService：NOTIFY 不需要切前台状态
            // （若服务已在运行，直接派发到 onStartCommand；若未运行，先创建再派发）
            ContextCompat.startForegroundService(context, intent)
        }

        /**
         * 创建通知通道。幂等，重复调用安全。必须在 Application/Activity 启动时调一次。
         *
         * 注意：Android 8.0+ channel 创建后，importance/sound/vibration 等字段不可通过
         * createNotificationChannel 覆盖（系统只允许用户手动降级，代码升级无效）。
         * 因此首次创建时必须配置正确。MainActivity.onCreate 里也内联了一份相同逻辑做双保险。
         */
        fun createChannels(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val manager = context.getSystemService(NotificationManager::class.java) ?: return
            // 常驻通知：低优先级、无声、无振动、不显示角标
            val serviceChannel = NotificationChannel(
                CHANNEL_SERVICE,
                "Marcel SSH 运行状态",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "前台保活服务的常驻通知，保证 SSH 会话与 Agent 任务在后台运行"
                setShowBadge(false)
                setSound(null, null)
                enableVibration(false)
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            }
            // Agent 事件通知：高优先级（弹横幅）+ 振动 + 无声
            val agentChannel = NotificationChannel(
                CHANNEL_AGENT,
                "Agent 通知",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Agent 审批、提问、任务完成与失败通知（振动提醒，无声）"
                setSound(null, null)
                enableVibration(true)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
            manager.createNotificationChannels(listOf(serviceChannel, agentChannel))
        }

        /** 启动前台服务（若已运行则更新通知）。 */
        fun start(context: Context, title: String, body: String) {
            val intent = Intent(context, MarcelForegroundService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_TITLE, title)
                putExtra(EXTRA_BODY, body)
            }
            ContextCompat.startForegroundService(context, intent)
        }

        /** 更新常驻通知内容（不改变服务运行状态）。 */
        fun update(context: Context, title: String, body: String) {
            val intent = Intent(context, MarcelForegroundService::class.java).apply {
                action = ACTION_UPDATE
                putExtra(EXTRA_TITLE, title)
                putExtra(EXTRA_BODY, body)
            }
            ContextCompat.startForegroundService(context, intent)
        }

        /** 停止前台服务。 */
        fun stop(context: Context) {
            val intent = Intent(context, MarcelForegroundService::class.java).apply {
                action = ACTION_STOP
            }
            ContextCompat.startForegroundService(context, intent)
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null
    /** 最近一次常驻通知内容，通知被移除后自愈重建时使用。 */
    private var lastTitle: String = "Marcel SSH"
    private var lastBody: String = "运行中"

    override fun onCreate() {
        super.onCreate()
        acquireWakeLock()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_NOTIFY -> {
                // Agent 事件通知：直接调 NotificationManager，不改变前台服务状态
                val id = intent.getIntExtra(EXTRA_NOTIFICATION_ID, System.currentTimeMillis().toInt())
                val title = intent.getStringExtra(EXTRA_TITLE) ?: "Marcel SSH"
                val body = intent.getStringExtra(EXTRA_BODY) ?: ""
                showAgentNotification(id, title, body)
                // 若服务原本未启动（仅被调来发通知），发完即停，避免空跑
                if (wakeLock?.isHeld != true) {
                    stopSelf()
                }
                return START_NOT_STICKY
            }
            ACTION_RESTORE -> {
                // 常驻通知被移除（滑动/系统清理等）后的自愈：
                // 前台服务通知一旦消失，系统会立即把服务降级为普通后台服务并可能杀掉，
                // 因此必须立刻重新 startForeground 把通知贴回来，保证保活不中断。
                startForeground(NOTIFICATION_ID_SERVICE, buildNotification(lastTitle, lastBody))
                return START_STICKY
            }
            else -> {
                // ACTION_START / ACTION_UPDATE / null：前台保活通知
                val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Marcel SSH"
                val body = intent?.getStringExtra(EXTRA_BODY) ?: "运行中"
                lastTitle = title
                lastBody = body
                startForeground(NOTIFICATION_ID_SERVICE, buildNotification(title, body))
            }
        }
        return START_STICKY
    }

    /**
     * 发送 Agent 事件通知（走 CHANNEL_AGENT）。
     * O+：振动/横幅由 channel（IMPORTANCE_HIGH + enableVibration(true)）控制，静音。
     * O-：由 NotificationCompat 控制 —— setVibrate 提供振动模式，setPriority(HIGH) 弹横幅，setSound(null) 静音。
     */
    private fun showAgentNotification(id: Int, title: String, body: String) {
        android.util.Log.i("MarcelService", "showAgentNotification: id=$id title=$title")
        val notification = NotificationCompat.Builder(this, CHANNEL_AGENT)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setSmallIcon(R.drawable.ic_notification)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setContentIntent(launchAppPendingIntent())
            .setSound(null)
            .setVibrate(longArrayOf(0, 250, 250, 250))
            .setAutoCancel(true)
            .build()
        try {
            NotificationManagerCompat.from(this).notify(id, notification)
            android.util.Log.i("MarcelService", "notify 成功: id=$id")
        } catch (e: SecurityException) {
            android.util.Log.e("MarcelService", "notify 失败(权限): ${e.message}", e)
        } catch (e: Exception) {
            android.util.Log.e("MarcelService", "notify 失败: ${e.message}", e)
        }
    }

    private fun buildNotification(title: String, body: String): Notification {
        return NotificationCompat.Builder(this, CHANNEL_SERVICE)
            .setContentTitle(title)
            .setContentText(body)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(launchAppPendingIntent())
            // 防移除自愈：通知被滑动/系统清理移除时，系统派发 deleteIntent，
            // 服务收到 ACTION_RESTORE 后立即重新 startForeground，保活不中断
            .setDeleteIntent(restorePendingIntent())
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setSound(null)
            .setVibrate(null)
            .setLocalOnly(true)
            .build()
    }

    /**
     * 通知被移除（滑动删除/系统清理）时系统派发的自愈 Intent。
     * O+ 用 getForegroundService 以 startForegroundService 语义派发，
     * 保证服务未运行时也能合法地在 onStartCommand 里调用 startForeground
     * （Android 12+ 普通 startService 启动的服务不允许再切前台）。
     */
    private fun restorePendingIntent(): PendingIntent {
        val intent = Intent(this, MarcelForegroundService::class.java).apply {
            action = ACTION_RESTORE
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            PendingIntent.getForegroundService(this, 0, intent, flags)
        } else {
            PendingIntent.getService(this, 0, intent, flags)
        }
    }

    /**
     * 通知点击回应用：调起 MainActivity（launchMode=singleTask）。
     * 用 SINGLE_TOP|CLEAR_TOP 复用已有任务栈（与 tauri-plugin-notification 的
     * buildIntent 行为一致），不重建 Activity、不丢应用状态。
     * targetSdk 36（Android 12+）必须 FLAG_IMMUTABLE，否则点击时崩溃。
     */
    private fun launchAppPendingIntent(): PendingIntent {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        return PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(POWER_SERVICE) as? PowerManager ?: return
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "marcel:sshkeepalive").apply {
            setReferenceCounted(false)
            // 不设超时：服务运行期间持续持有，进程被杀时系统自动释放
            acquire()
        }
    }

    private fun releaseWakeLock() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
    }

    override fun onDestroy() {
        releaseWakeLock()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
