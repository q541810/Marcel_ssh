import Toggle from '@/components/ui/Toggle';
import { useSettingsActions } from '@/components/settings/SettingsActionsContext';
import { MobileSettingRow } from './MobileSettingRow';

/** Conversation display options for mobile — mirrors desktop ConversationDisplaySection. */
export function MobileDisplaySection() {
  const { settings, update } = useSettingsActions();

  return (
    <div className="flex flex-col gap-2">
      <MobileSettingRow
        label="隐藏模型思考"
        description="不显示模型的推理/思考内容"
        trailing={
          <Toggle
            checked={settings.hideThinkingDisplay}
            onChange={(checked) => update({ hideThinkingDisplay: checked })}
          />
        }
      />
    </div>
  );
}
