import { AlertCircle } from 'lucide-react';
import Toggle from '@/components/ui/Toggle';
import { useSettingsActions } from '@/components/settings/SettingsActionsContext';
import {
  isAndroidBridgeAvailable,
  isNotificationPermissionGranted,
} from '../mobileBridge';
import { MobileSettingRow } from './MobileSettingRow';

/**
 * 移动端通知设置页。
 *
 * 4 个 Agent 事件开关，与桌面端 NotificationSettings 完全隔离：
 * - 不参与云端同步（settings_field.rs 白名单未包含 mobileNotificationSettings）
 * - 无提示音（marcel_agent channel IMPORTANCE_HIGH 无声）
 * - 桌面端 notificationVolume 等字段不在此处暴露
 *
 * 通知路径：Rust notification.rs → window.AndroidBridge.sendAgentNotification
 * → NotificationManagerCompat 走 marcel_agent channel（无声横幅）。
 */
export function MobileNotificationSection() {
  const { settings, update } = useSettingsActions();
  const ns = settings.mobileNotificationSettings;

  const bridgeAvailable = isAndroidBridgeAvailable();
  const permissionGranted = isNotificationPermissionGranted();
  // 非 Android 环境（桌面 / 浏览器预览）不展示开关——避免误以为可生效。
  // 权限未授予时仍展示开关，但加提示让用户去系统设置授权。
  if (!bridgeAvailable) {
    return (
      <div className="flex flex-col items-center py-8 text-center">
        <AlertCircle className="w-6 h-6 mb-2 text-zinc-600" />
        <p className="text-sm text-zinc-500">
          通知仅在 Android 端可用
        </p>
      </div>
    );
  }

  const setField = (key: keyof typeof ns, value: boolean) => {
    update({ mobileNotificationSettings: { ...ns, [key]: value } });
  };

  return (
    <div className="flex flex-col gap-2">
      {!permissionGranted && (
        <div className="rounded-lg border border-amber-800/60 bg-amber-950/30 px-3 py-2 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
          <p className="flex-1 text-xs leading-relaxed text-amber-300">
            系统通知权限未授予，Agent 事件提醒无法弹出。请到系统设置 → 应用 → Marcel SSH → 通知 中开启。
          </p>
        </div>
      )}

      <MobileSettingRow
        label="审批请求"
        description="Agent 执行命令前请求确认时通知"
        trailing={
          <Toggle
            checked={ns.agentApproval}
            onChange={(v) => setField('agentApproval', v)}
          />
        }
      />
      <MobileSettingRow
        label="提问"
        description="Agent 需要用户回答问题时通知"
        trailing={
          <Toggle
            checked={ns.agentQuestion}
            onChange={(v) => setField('agentQuestion', v)}
          />
        }
      />
      <MobileSettingRow
        label="任务完成"
        description="Agent 任务正常结束时通知"
        trailing={
          <Toggle
            checked={ns.agentTaskDone}
            onChange={(v) => setField('agentTaskDone', v)}
          />
        }
      />
      <MobileSettingRow
        label="任务失败"
        description="Agent 任务出错或被中断时通知"
        trailing={
          <Toggle
            checked={ns.agentTaskFailed}
            onChange={(v) => setField('agentTaskFailed', v)}
          />
        }
      />

      <p className="mt-2 px-1 text-xs leading-relaxed text-zinc-500">
        仅在 App 切到后台时弹出系统通知（无声横幅 + 振动）。前台不打扰。本配置独立于桌面端，不参与云端同步。
      </p>
    </div>
  );
}
