import Toggle from '@/components/ui/Toggle';
import { Card, SettingItem } from './helpers';
import { useSettingsActions } from './SettingsActionsContext';

export function DisplaySection() {
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
    </Card>
  );
}
