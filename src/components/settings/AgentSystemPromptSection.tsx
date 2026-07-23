import { Card, SettingItem } from './helpers';
import { useSettingsActions } from './SettingsActionsContext';

export function AgentSystemPromptSection() {
  const { settings, update } = useSettingsActions();
  const agent = settings.agentModeSettings;

  const updateAgent = (patch: Partial<typeof agent>) => {
    update({ agentModeSettings: { ...agent, ...patch } });
  };

  return (
    <Card id="settings-agent-system-prompt" title="用户附加指令" description="在 Agent 调用 LLM 时，将此处内容追加到系统提示词末尾">
      <SettingItem
        id="agent-system-prompt-textarea"
        label="追加内容"
        description="此处为空时不注入任何额外内容"
        sectionId="settings-agent-system-prompt"
        keywords={['system', 'prompt', '指令', '提示词', 'Agent']}
      >
        <textarea
          value={agent.systemPrompt ?? ''}
          onChange={(e) => updateAgent({ systemPrompt: e.target.value })}
          rows={6}
          className="w-full resize-y rounded-md bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-green-500 placeholder:text-zinc-500"
          placeholder="在此输入需要附加到系统提示词中的内容，将在每次 Agent 任务调用 LLM 时生效"
        />
      </SettingItem>
    </Card>
  );
}
