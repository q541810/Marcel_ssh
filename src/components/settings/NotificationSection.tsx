import { Volume2, VolumeX } from 'lucide-react';
import type { NotificationSettings } from '@/lib/types';
import Toggle from '@/components/ui/Toggle';
import { Card, SettingItem } from './helpers';
import { useSettingsActions } from './SettingsActionsContext';
import {
  previewNotificationSound,
  setNotificationVolume,
} from '@/lib/notificationSound';

function PreviewButton({ kind }: { kind: string }) {
  return (
    <button
      type="button"
      onClick={() => previewNotificationSound(kind)}
      className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
      title="试听"
    >
      <Volume2 className="w-4 h-4" />
    </button>
  );
}

function VolumeSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2 w-full max-w-48">
      {value === 0 ? (
        <VolumeX className="w-4 h-4 shrink-0 text-[var(--color-text-secondary)]" />
      ) : (
        <Volume2 className="w-4 h-4 shrink-0 text-[var(--color-text-secondary)]" />
      )}
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          const v = Number(e.target.value);
          onChange(v);
          setNotificationVolume(v);
        }}
        className="w-full h-1.5 appearance-none cursor-pointer rounded-full"
        style={{
          background: `linear-gradient(to right, var(--color-accent) 0%, var(--color-accent) ${value}%, var(--color-bg-tertiary) ${value}%, var(--color-bg-tertiary) 100%)`,
        }}
      />
      <span className="text-xs text-[var(--color-text-secondary)] w-8 text-right tabular-nums">
        {value}
      </span>
    </div>
  );
}

export function NotificationSection() {
  const { settings, update } = useSettingsActions();

  const ns = settings.notificationSettings ?? {
    agentApproval: true,
    agentTaskDone: true,
    agentTaskFailed: true,
    notificationVolume: 80,
  };

  const updateNotification = (patch: Partial<NotificationSettings>) => {
    update({ notificationSettings: { ...ns, ...patch } });
  };

  return (
    <Card
      id="settings-notification"
      title="系统通知"
      description="控制哪些事件触发操作系统的桌面通知"
    >
      <SettingItem
        id="notif-volume"
        label="提示音量"
        description="调整通知提示音的响度"
        sectionId="settings-notification"
        keywords={['通知', 'notification', '音量', 'volume', '声音', 'sound']}
        density="compact"
      >
        <VolumeSlider
          value={ns.notificationVolume}
          onChange={(v) => {
            updateNotification({ notificationVolume: v });
            setNotificationVolume(v);
          }}
        />
      </SettingItem>
      <SettingItem
        id="notif-approval"
        label="Agent 需要批准"
        description="需要确认操作时提醒"
        sectionId="settings-notification"
        keywords={['通知', 'notification', 'approval', '批准', 'Agent']}
        density="compact"
      >
        <div className="flex items-center gap-1">
          <PreviewButton kind="AgentApproval" />
          <Toggle
            checked={ns.agentApproval}
            onChange={(checked) => updateNotification({ agentApproval: checked })}
          />
        </div>
      </SettingItem>
      <SettingItem
        id="notif-done"
        label="Agent 任务完成"
        description="任务成功结束时提醒"
        sectionId="settings-notification"
        keywords={['通知', 'notification', 'done', '完成', 'Agent']}
        density="compact"
      >
        <div className="flex items-center gap-1">
          <PreviewButton kind="AgentTaskDone" />
          <Toggle
            checked={ns.agentTaskDone}
            onChange={(checked) => updateNotification({ agentTaskDone: checked })}
          />
        </div>
      </SettingItem>
      <SettingItem
        id="notif-failed"
        label="Agent 任务失败"
        description="任务报错或达到轮数限制时提醒"
        sectionId="settings-notification"
        keywords={['通知', 'notification', 'failed', '失败', 'Agent']}
        density="compact"
      >
        <div className="flex items-center gap-1">
          <PreviewButton kind="AgentTaskFailed" />
          <Toggle
            checked={ns.agentTaskFailed}
            onChange={(checked) => updateNotification({ agentTaskFailed: checked })}
          />
        </div>
      </SettingItem>
    </Card>
  );
}
