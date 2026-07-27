import Toggle from '@/components/ui/Toggle';
import { Card, SettingItem } from './helpers';
import { useSettingsActions } from './SettingsActionsContext';

export function ConversationDisplaySection() {
  const { settings, update } = useSettingsActions();

  return (
    <Card id="settings-display" title="对话显示" description="控制 Agent 对话内容在界面中的呈现方式">
      <SettingItem
        id="hide-thinking"
        label="隐藏模型思考"
        description="不显示模型的推理/思考内容"
        sectionId="settings-display"
        keywords={['thinking', 'reasoning', 'hide', '思考', '推理', '界面', '对话显示']}
      >
        <Toggle
          checked={settings.hideThinkingDisplay}
          onChange={(checked) => update({ hideThinkingDisplay: checked })}
          label="开启后隐藏思考过程"
        />
      </SettingItem>
      <SettingItem
        id="privacy-mode"
        label="隐私模式"
        description="开启后所有界面隐藏 IP 地址和端口（连接功能不受影响）"
        sectionId="settings-display"
        keywords={['privacy', 'ip', 'port', 'mask', '隐藏', '脱敏', '界面', '对话显示']}
      >
        <Toggle
          checked={settings.privacyMode ?? false}
          onChange={(checked) => update({ privacyMode: checked })}
          label="连接列表、快速连接、HostKey 提示等地方用 *** / **** 替代真实 IP 和端口"
        />
      </SettingItem>
    </Card>
  );
}
