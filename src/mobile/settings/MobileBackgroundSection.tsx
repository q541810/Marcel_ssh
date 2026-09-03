import { useState } from 'react';
import { AlertCircle, Battery, Loader2 } from 'lucide-react';
import Toggle from '@/components/ui/Toggle';
import { useSettingsActions } from '@/components/settings/SettingsActionsContext';
import { getErrorMessage } from '@/lib/errors';
import {
  isAndroidBridgeAvailable,
  isNotificationPermissionGranted,
  requestNotificationPermission,
  startForegroundService,
  stopForegroundService,
} from '../mobileBridge';
import { MobileSettingRow } from './MobileSettingRow';

/**
 * 移动端后台保活设置页。
 *
 * 开启后 App 启动即启动 Android 前台服务（MarcelForegroundService）：
 * - 持有 PARTIAL_WAKE_LOCK 防止 CPU 休眠
 * - 常驻通知（marcel_service channel，IMPORTANCE_LOW 无声）
 * - SSH keepalive 与 Agent tokio 任务得以在后台持续运行
 *
 * 关闭时停止前台服务，切后台后系统可能冻结进程导致 SSH 断线。
 *
 * 设备本地设置，每台设备独立生效。
 */
export function MobileBackgroundSection() {
  const { settings, update } = useSettingsActions();
  const enabled = settings.mobileBackgroundSettings.keepAliveEnabled;
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bridgeAvailable = isAndroidBridgeAvailable();

  if (!bridgeAvailable) {
    return (
      <div className="flex flex-col items-center py-8 text-center">
        <AlertCircle className="w-6 h-6 mb-2 text-zinc-600" />
        <p className="text-sm text-zinc-500">
          后台保活仅在 Android 端可用
        </p>
      </div>
    );
  }

  const handleToggle = async (next: boolean) => {
    setError(null);
    if (next) {
      // 开启：先确保通知权限（前台服务需要展示常驻通知）
      setToggling(true);
      try {
        if (!isNotificationPermissionGranted()) {
          const granted = await requestNotificationPermission();
          if (!granted) {
            setError(
              '通知权限被拒绝，无法启动前台服务。请到系统设置 → 应用 → Marcel SSH → 通知 中开启后重试。',
            );
            return;
          }
        }
        startForegroundService('Marcel SSH', '运行中');
        update({ mobileBackgroundSettings: { keepAliveEnabled: true } });
      } catch (e) {
        setError(`启动前台服务失败：${getErrorMessage(e)}`);
      } finally {
        setToggling(false);
      }
    } else {
      // 关闭：停止前台服务
      try {
        stopForegroundService();
        update({ mobileBackgroundSettings: { keepAliveEnabled: false } });
      } catch (e) {
        setError(`停止前台服务失败：${getErrorMessage(e)}`);
      }
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <div className="rounded-lg border border-red-800/60 bg-red-950/30 px-3 py-2 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
          <p className="flex-1 text-xs leading-relaxed text-red-300">{error}</p>
        </div>
      )}

      <MobileSettingRow
        label="后台保活"
        description="开启后 App 启动即启动前台服务，切后台保持 SSH 会话与 Agent 任务运行"
        trailing={
          <Toggle
            checked={enabled}
            onChange={(v) => void handleToggle(v)}
            disabled={toggling}
          />
        }
      />

      {toggling && (
        <div className="flex items-center justify-center gap-2 py-2 text-xs text-zinc-400">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          正在请求权限…
        </div>
      )}

      <div className="mt-2 rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
        <div className="mb-2 flex items-center gap-2">
          <Battery className="w-4 h-4 text-zinc-400" />
          <span className="text-xs font-medium text-zinc-300">工作原理</span>
        </div>
        <ul className="space-y-1.5 text-xs leading-relaxed text-zinc-500">
          <li>· 前台服务持有 WakeLock，防止 CPU 进入深度休眠</li>
          <li>· SSH keepalive（30s）持续发包，维持长连接</li>
          <li>· Agent 任务在 Rust tokio 运行时中持续执行</li>
          <li>· 常驻通知（无声）显示在状态栏，不可滑动清除</li>
        </ul>
      </div>

      <div className="rounded-xl border border-amber-900/40 bg-amber-950/20 p-3">
        <div className="mb-1.5 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-amber-400" />
          <span className="text-xs font-medium text-amber-300">注意事项</span>
        </div>
        <ul className="space-y-1.5 text-xs leading-relaxed text-amber-400/80">
          <li>· 系统仍可能在极端情况下（低内存、电池优化）杀死进程</li>
          <li>· 进程被杀后不会自动重连 SSH，需手动重新打开 App</li>
          <li>· 部分厂商 ROM 需在系统设置中关闭「电池优化」才能稳定保活</li>
          <li>· 此配置为设备本地设置，每台设备独立生效</li>
        </ul>
      </div>
    </div>
  );
}
