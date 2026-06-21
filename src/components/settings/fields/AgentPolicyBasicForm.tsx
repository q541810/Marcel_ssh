import Toggle from '@/components/ui/Toggle';
import type { AgentModeSettings } from '@/lib/types';

interface AgentPolicyBasicFormProps {
  value: Pick<AgentModeSettings, 'confirmEachCommand' | 'commandList' | 'listMode'>;
  onChange: (patch: Partial<AgentModeSettings>) => void;
}

export function AgentPolicyBasicForm({ value, onChange }: AgentPolicyBasicFormProps) {
  const agent = value;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 divide-y divide-zinc-800">
      <div className="px-6 py-4">
        <div className="flex items-center gap-6">
          <div className="flex-shrink-0 w-32 text-sm font-medium text-zinc-200">命令确认</div>
          <Toggle
            checked={agent.confirmEachCommand}
            onChange={(checked) => onChange({ confirmEachCommand: checked })}
            label="每条命令都需要确认"
          />
        </div>
      </div>

      <div className="px-6 py-4">
        <div className="flex items-center gap-6">
          <div className="flex-shrink-0 w-32 text-sm font-medium text-zinc-200">
            {agent.listMode === 'allowlist' ? '允许的命令' : '禁止的命令'}
          </div>
          <div className="flex-1 flex flex-wrap gap-1.5">
            {agent.commandList.map((cmd) => (
              <span
                key={cmd}
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-zinc-800 border border-zinc-700 text-xs font-mono text-zinc-200"
              >
                {cmd}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
