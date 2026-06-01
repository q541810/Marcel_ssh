import { useState } from 'react';
import type { AgentModeSettings, CommandListMode, CommandCheckResult } from '@/lib/types';
import * as tauri from '@/lib/tauri';
import Button from '@/components/ui/Button';
import Toggle from '@/components/ui/Toggle';
import { Section, Field } from './helpers';

function ListModeButton({
  value,
  current,
  onClick,
  label,
  description,
  position,
}: {
  value: CommandListMode;
  current: CommandListMode;
  onClick: (v: CommandListMode) => void;
  label: string;
  description: string;
  position?: 'first' | 'last' | 'middle';
}) {
  const active = value === current;
  const roundedClass = position === 'first' 
    ? 'rounded-l-lg' 
    : position === 'last' 
      ? 'rounded-r-lg' 
      : '';

  return (
    <button
      onClick={() => onClick(value)}
      title={description}
      className={`
        flex-1 px-4 py-2 text-sm transition-colors border-r border-zinc-700 last:border-r-0
        ${roundedClass}
        ${
          active
            ? 'bg-indigo-600 text-white'
            : 'bg-zinc-800/50 text-zinc-300 hover:bg-zinc-700'
        }
      `}
      style={{ transitionTimingFunction: 'var(--spring-bounce)' }}
    >
      {label}
    </button>
  );
}

interface CommandPolicySectionProps {
  agent: AgentModeSettings;
  updateAgent: (mutator: (a: AgentModeSettings) => AgentModeSettings) => void;
}

export function CommandPolicySection({ agent, updateAgent }: CommandPolicySectionProps) {
  const [newCommand, setNewCommand] = useState('');
  const [testCommand, setTestCommand] = useState('');
  const [testResult, setTestResult] = useState<CommandCheckResult | null>(null);
  const [testing, setTesting] = useState(false);

  const handleAddCommand = () => {
    const v = newCommand.trim();
    if (!v) return;
    updateAgent((a) => {
      if (a.commandList.includes(v)) return a;
      return { ...a, commandList: [...a.commandList, v] };
    });
    setNewCommand('');
  };

  const handleRemoveCommand = (cmd: string) => {
    updateAgent((a) => ({
      ...a,
      commandList: a.commandList.filter((c) => c !== cmd),
    }));
  };

  const runTest = async () => {
    const cmd = testCommand.trim();
    if (!cmd) return;
    setTesting(true);
    try {
      const result = await tauri.agentCheckCommand(cmd, 'agent');
      setTestResult(result);
    } catch (err) {
      console.error(err);
      setTestResult({
        allowed: false,
        requiresConfirmation: false,
        riskLevel: 'Moderate',
        reason: `测试失败：${String(err)}`,
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Section
      id="settings-command-policy"
      title="AGENT 模式 — 命令执行策略"
      description="仅在 AGENT 模式下生效。CHAT 模式不会执行命令；AUTO 模式不受此处限制。"
    >
      <Field label="列表模式">
        <div className="flex rounded-lg overflow-hidden border border-zinc-700">
          <ListModeButton
            value="denylist"
            current={agent.listMode}
            onClick={(v) =>
              updateAgent((a) => ({ ...a, listMode: v }))
            }
            label="黑名单"
            description="只阻止列表中的命令"
            position="first"
          />
          <ListModeButton
            value="allowlist"
            current={agent.listMode}
            onClick={(v) =>
              updateAgent((a) => ({ ...a, listMode: v }))
            }
            label="白名单"
            description="只允许列表中的命令"
            position="last"
          />
        </div>
      </Field>

      <Field label="逐条确认">
        <Toggle
          checked={agent.confirmEachCommand}
          onChange={(checked) =>
            updateAgent((a) => ({
              ...a,
              confirmEachCommand: checked,
            }))
          }
          label="即使通过列表过滤，仍要求用户确认每条命令"
        />
      </Field>

      <Field
        label={agent.listMode === 'allowlist' ? '允许的命令' : '禁止的命令'}
        alignTop
      >
        <div className="flex-1 space-y-2 min-w-0">
          <div className="flex gap-2">
            <input
              type="text"
              value={newCommand}
              onChange={(e) => setNewCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddCommand();
                }
              }}
              placeholder="例如：rm 或 sudo"
              className="flex-1 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500"
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={handleAddCommand}
              disabled={!newCommand.trim()}
            >
              添加
            </Button>
          </div>
          {agent.commandList.length === 0 ? (
            <p className="text-xs text-zinc-500 italic px-1">列表为空</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {agent.commandList.map((cmd) => (
                <span
                  key={cmd}
                  className="group inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-zinc-800 border border-zinc-700 text-xs font-mono text-zinc-200"
                >
                  {cmd}
                  <button
                    onClick={() => handleRemoveCommand(cmd)}
                    className="text-zinc-500 hover:text-red-400 transition-colors"
                    aria-label={`移除 ${cmd}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <p className="text-xs text-zinc-500">
            按基础命令名匹配（不含路径或参数）。例如填{' '}
            <code className="text-zinc-400">rm</code> 会匹配{' '}
            <code className="text-zinc-400">rm -rf /tmp</code>。
          </p>
        </div>
      </Field>

      <Field label="测试命令" alignTop>
        <div className="flex-1 space-y-2 min-w-0">
          <p className="text-xs text-zinc-500">
            输入一条命令，查看在 AGENT 模式下是否会被允许。使用的是{' '}
            <span className="text-amber-400">已保存</span>的规则（请先点保存）。
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={testCommand}
              onChange={(e) => setTestCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void runTest();
                }
              }}
              placeholder="例如：rm -rf /tmp/test"
              className="flex-1 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500"
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={runTest}
              loading={testing}
              disabled={!testCommand.trim()}
            >
              测试
            </Button>
          </div>
          {testResult && (
            <div
              className={`
                rounded-xl border px-3 py-2 text-sm
                ${
                  testResult.allowed
                    ? 'bg-emerald-950/40 border-emerald-800 text-emerald-200'
                    : 'bg-red-950/40 border-red-800 text-red-200'
                }
              `}
            >
              <div className="font-medium">
                {testResult.allowed ? '允许' : '阻止'}
                {testResult.allowed && testResult.requiresConfirmation && (
                  <span className="ml-2 text-xs text-amber-300">
                    （需要用户确认）
                  </span>
                )}
              </div>
              <div className="text-xs opacity-80 mt-0.5">
                风险等级：{testResult.riskLevel} · {testResult.reason}
              </div>
            </div>
          )}
        </div>
      </Field>
    </Section>
  );
}
