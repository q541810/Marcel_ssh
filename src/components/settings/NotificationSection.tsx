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
        description="当 Agent 执行操作需要用户确认时发送通知"
        sectionId="settings-notification"
        keywords={['通知', 'notification', 'approval', '批准', 'Agent']}
      >
        <Toggle
          checked={ns.agentApproval}
          onChange={(checked) => updateNotification({ agentApproval: checked })}
          label="启用"
        />
      </SettingItem>
      <SettingItem
        id="notif-done"
        label="Agent 任务完成"
        description="当 Agent 任务成功完成时发送通知"
        sectionId="settings-notification"
        keywords={['通知', 'notification', 'done', '完成', 'Agent']}
      >
        <Toggle
          checked={ns.agentTaskDone}
          onChange={(checked) => updateNotification({ agentTaskDone: checked })}
          label="启用"
        />
      </SettingItem>
      <SettingItem
        id="notif-failed"
        label="Agent 任务失败"
        description="当 Agent 任务执行失败时发送通知"
        sectionId="settings-notification"
        keywords={['通知', 'notification', 'failed', '失败', 'Agent']}
      >
        <Toggle
          checked={ns.agentTaskFailed}
          onChange={(checked) => updateNotification({ agentTaskFailed: checked })}
          label="启用"
        />
      </SettingItem>
    </Card>
  );
}
