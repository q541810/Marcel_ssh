import Toggle from '@/components/ui/Toggle';
import { mergeWorkspaceLayout } from '@/lib/workspaceLayout';
import { Card, SettingItem } from './helpers';
import { useSettingsActions } from './SettingsActionsContext';

export function WorkspaceLayoutSection() {
  const { settings, update } = useSettingsActions();
  const agentPrimary = settings.workspaceLayout?.agentPrimary ?? false;

  return (
    <Card
      id="settings-layout"
      title="工作区布局"
      description="终端与 Agent 面板谁占中间主区域"
    >
      <SettingItem
        id="agent-primary"
        label="Agent 占主区域"
        description="与终端互换位置：Agent 占据中间主区域，终端收进右侧可拖宽的窄栏"
        sectionId="settings-layout"
        keywords={['layout', 'swap', 'panel', 'terminal', 'agent', '布局', '互换', '位置', '主区域', '界面']}
      >
        <Toggle
          checked={agentPrimary}
          onChange={(checked) =>
            // 走 mergeWorkspaceLayout 而不是手拼对象：缺字段补默认、越界宽度夹取只有这一条权威路径
            update({
              workspaceLayout: mergeWorkspaceLayout(settings.workspaceLayout, {
                agentPrimary: checked,
              }),
            })
          }
          label={
            agentPrimary
              ? 'Agent 在中间，终端在右侧（各自的宽度分开记）'
              : '终端在中间，Agent 在右侧'
          }
        />
      </SettingItem>
    </Card>
  );
}
