import type { NotificationSettings } from '@/lib/types';
import Toggle from '@/components/ui/Toggle';
import { Card, SettingItem } from './helpers';
import { useSettingsActions } from './SettingsActionsContext';

export function NotificationSection() {
  const { settings, update } = useSettingsActions();

  const ns = settings.notificationSettings ?? {
    agentApproval: true,
    agentTaskDone: true,
    agentTaskFailed: true,
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
        id="notif-approval"
        label="Agent 需要批准"
        description="需要确认操作时提醒"
        sectionId="settings-notification"
        keywords={['通知', 'notification', 'approval', '批准', 'Agent']}
        density="compact"
      >
        <Toggle
          checked={ns.agentApproval}
          onChange={(checked) => updateNotification({ agentApproval: checked })}
        />
      </SettingItem>
      <SettingItem
        id="notif-done"
        label="Agent 任务完成"
        description="任务成功结束时提醒"
        sectionId="settings-notification"
        keywords={['通知', 'notification', 'done', '完成', 'Agent']}
        density="compact"
      >
        <Toggle
          checked={ns.agentTaskDone}
          onChange={(checked) => updateNotification({ agentTaskDone: checked })}
        />
      </SettingItem>
      <SettingItem
        id="notif-failed"
        label="Agent 任务失败"
        description="任务报错或达到轮数限制时提醒"
        sectionId="settings-notification"
        keywords={['通知', 'notification', 'failed', '失败', 'Agent']}
        density="compact"
      >
        <Toggle
          checked={ns.agentTaskFailed}
          onChange={(checked) => updateNotification({ agentTaskFailed: checked })}
        />
      </SettingItem>
    </Card>
  );
}
