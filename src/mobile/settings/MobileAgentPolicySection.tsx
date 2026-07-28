import { useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { CommandCheckResult, CommandListMode } from '@/lib/types';
import * as tauri from '@/lib/tauri';
import { getErrorMessage } from '@/lib/errors';
import Toggle from '@/components/ui/Toggle';
import { useSettingsActions } from '@/components/settings/SettingsActionsContext';
import {
  DEFAULT_APPROVAL_PROMPT,
  preCheckCustomPath,
} from '@/components/settings/AgentPolicySection';
import { MobileSettingRow } from './MobileSettingRow';

const BUILT_IN_PROTECTED: ReadonlyArray<{ path: string; reason: string }> = [
  { path: '/etc', reason: '系统配置' },
  { path: '/boot', reason: '启动分区' },
  { path: '/sys', reason: 'sysfs 设备' },
  { path: '/proc', reason: '进程信息' },
  { path: '/dev', reason: '设备文件' },
];

const inputClass =
  'w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-indigo-500 disabled:opacity-40';

/** Full agent command policy for mobile — same settings surface as desktop. */
export function MobileAgentPolicySection() {
  const { settings, update } = useSettingsActions();
  const agent = settings.agentModeSettings;

  const updateAgent = (patch: Partial<typeof agent>) => {
    update({ agentModeSettings: { ...agent, ...patch } });
  };

  const [newCommand, setNewCommand] = useState('');
  const [testCommand, setTestCommand] = useState('');
  const [testResult, setTestResult] = useState<CommandCheckResult | null>(null);
  const [testing, setTesting] = useState(false);

  const customPaths = settings.customProtectedPaths ?? [];
  const [draftPath, setDraftPath] = useState('');
  const [pathError, setPathError] = useState<string | null>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);

  const listDisabled = agent.confirmEachCommand;

  const handleAddCommand = () => {
    const v = newCommand.trim();
    if (!v) return;
    if (!agent.commandList.includes(v)) {
      updateAgent({ commandList: [...agent.commandList, v] });
    }
    setNewCommand('');
  };

  const handleAddProtectedPath = async () => {
    const trimmed = draftPath.trim();
    if (!trimmed) return;
    const localErr = preCheckCustomPath(trimmed, customPaths);
    if (localErr) {
      setPathError(localErr);
      return;
    }
    const err = await tauri.validateCustomProtectedPaths([trimmed]);
    if (err) {
      setPathError(err);
      return;
    }
    setPathError(null);
    setDraftPath('');
    update({ customProtectedPaths: [...customPaths, trimmed] });
    pathInputRef.current?.focus();
  };

  const runTest = async () => {
    const cmd = testCommand.trim();
    if (!cmd) return;
    setTesting(true);
    try {
      setTestResult(await tauri.agentCheckCommand(cmd, 'agent'));
    } catch (err) {
      setTestResult({
        allowed: false,
        requiresConfirmation: false,
        riskLevel: 'Moderate',
        reason: `测试失败：${getErrorMessage(err)}`,
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Command timeout */}
      <MobileSettingRow
        label="命令超时时间"
        description="Agent 执行单条命令的最大等待时间"
        trailing={
          <span className="w-14 text-right font-mono text-sm text-indigo-300">
            {settings.commandTimeoutSecs ?? 120}s
          </span>
        }
      >
        <input
          type="range"
          min={10}
          max={300}
          step={10}
          value={settings.commandTimeoutSecs ?? 120}
          onChange={(e) =>
            update({ commandTimeoutSecs: Number(e.target.value) })
          }
          className="mt-1 h-2 w-full cursor-pointer appearance-none rounded-full bg-zinc-700 accent-indigo-500"
        />
      </MobileSettingRow>

      {/* Key toggles */}
      <MobileSettingRow
        label="每条都手动确认"
        description="即使通过列表过滤，仍要求确认每条命令"
        trailing={
          <Toggle
            checked={agent.confirmEachCommand}
            onChange={(checked) => updateAgent({ confirmEachCommand: checked })}
          />
        }
      />
      <MobileSettingRow
        label="编辑文件审批"
        description="edit_file 执行前需要确认"
        trailing={
          <Toggle
            checked={agent.confirmEditFile ?? true}
            onChange={(checked) => updateAgent({ confirmEditFile: checked })}
          />
        }
      />

      {/* Model approval */}
      <MobileSettingRow
        label="执行前模型审批"
        description="执行命令前让模型判定放行/转人工/阻止"
        trailing={
          <Toggle
            checked={agent.enableModelCommandApproval ?? false}
            onChange={(checked) =>
              updateAgent({ enableModelCommandApproval: checked })
            }
          />
        }
      >
        {agent.enableModelCommandApproval && (
          <div className="mt-2 space-y-1.5">
            <input
              type="text"
              value={agent.modelApprovalModel ?? ''}
              onChange={(e) =>
                updateAgent({ modelApprovalModel: e.target.value })
              }
              placeholder="审批模型（留空使用主模型）"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className={inputClass}
            />
            <p className="text-xs text-zinc-500">
              填写轻量模型可降低审批延迟和成本
            </p>
            <div className="flex items-center justify-between pt-1">
              <span className="text-xs text-zinc-400">审批提示词</span>
              <button
                type="button"
                onClick={() => updateAgent({ modelApprovalPrompt: '' })}
                className="text-xs text-zinc-500 active:text-zinc-300"
              >
                恢复默认
              </button>
            </div>
            <textarea
              value={agent.modelApprovalPrompt || DEFAULT_APPROVAL_PROMPT}
              onChange={(e) => {
                const v = e.target.value;
                updateAgent({
                  modelApprovalPrompt: v === DEFAULT_APPROVAL_PROMPT ? '' : v,
                });
              }}
              rows={6}
              className="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-xs text-zinc-100 outline-none focus:border-indigo-500"
            />
          </div>
        )}
      </MobileSettingRow>

      {/* List mode + command list */}
      <MobileSettingRow
        label="命令列表过滤"
        description={
          listDisabled
            ? '已开启「每条都手动确认」，列表过滤不生效'
            : '按基础命令名匹配（不含路径或参数）'
        }
      >
        <div className={listDisabled ? 'pointer-events-none opacity-40' : ''}>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {(
              [
                {
                  value: 'denylist',
                  label: '黑名单',
                  desc: '只阻止列表中的命令',
                },
                {
                  value: 'allowlist',
                  label: '白名单',
                  desc: '只允许列表中的命令',
                },
              ] as { value: CommandListMode; label: string; desc: string }[]
            ).map((m) => {
              const active = agent.listMode === m.value;
              return (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => updateAgent({ listMode: m.value })}
                  className={`rounded-xl border px-3 py-2.5 text-left transition-colors duration-100 active:scale-[0.99] ${
                    active
                      ? 'border-indigo-500 bg-indigo-500/10'
                      : 'border-zinc-700 bg-zinc-800/60'
                  }`}
                >
                  <div
                    className={`text-sm font-medium ${
                      active ? 'text-indigo-200' : 'text-zinc-300'
                    }`}
                  >
                    {m.label}
                  </div>
                  <div className="mt-0.5 text-[11px] text-zinc-500">
                    {m.desc}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="mt-2 flex gap-2">
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
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={listDisabled}
              className={inputClass}
            />
            <button
              type="button"
              onClick={handleAddCommand}
              disabled={!newCommand.trim() || listDisabled}
              className="flex-shrink-0 rounded-lg bg-zinc-800 px-4 py-2.5 text-sm text-zinc-200 active:bg-zinc-700 disabled:opacity-40"
            >
              添加
            </button>
          </div>

          {agent.commandList.length === 0 ? (
            <p className="mt-2 px-1 text-xs italic text-zinc-500">列表为空</p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {agent.commandList.map((cmd) => (
                <span
                  key={cmd}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 font-mono text-xs text-zinc-200"
                >
                  {cmd}
                  <button
                    type="button"
                    onClick={() =>
                      updateAgent({
                        commandList: agent.commandList.filter((c) => c !== cmd),
                      })
                    }
                    disabled={listDisabled}
                    className="-mr-0.5 px-0.5 text-zinc-500 active:text-red-400"
                    aria-label={`移除 ${cmd}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </MobileSettingRow>

      {/* Command test */}
      <MobileSettingRow
        label="测试命令"
        description="输入一条命令，查看在 AGENT 模式下是否会被允许"
      >
        <div className="mt-2 flex gap-2">
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
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className={inputClass}
          />
          <button
            type="button"
            onClick={() => void runTest()}
            disabled={!testCommand.trim() || testing}
            className="flex-shrink-0 rounded-lg bg-zinc-800 px-4 py-2.5 text-sm text-zinc-200 active:bg-zinc-700 disabled:opacity-40"
          >
            {testing ? '测试中' : '测试'}
          </button>
        </div>
        {testResult && (
          <div
            className={`mt-2 rounded-xl border px-3 py-2 text-sm ${
              testResult.allowed
                ? 'border-emerald-800 bg-emerald-950/40 text-emerald-200'
                : 'border-red-800 bg-red-950/40 text-red-200'
            }`}
          >
            <div className="font-medium">
              {testResult.allowed ? '允许' : '阻止'}
              {testResult.allowed && testResult.requiresConfirmation && (
                <span className="ml-2 text-xs text-amber-300">
                  （需要用户确认）
                </span>
              )}
            </div>
            <div className="mt-0.5 text-xs opacity-80">
              风险等级：{testResult.riskLevel} · {testResult.reason}
            </div>
          </div>
        )}
      </MobileSettingRow>

      {/* Protected paths */}
      <MobileSettingRow
        label="受保护路径"
        description="Agent 在这些路径下的写操作会触发用户审批"
      >
        <div className="mt-2 space-y-2">
          <div>
            <p className="mb-1 text-xs text-zinc-500">内置保护路径（只读）</p>
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-zinc-400">
              {BUILT_IN_PROTECTED.map((p) => (
                <span key={p.path} className="whitespace-nowrap">
                  <code className="text-indigo-300">{p.path}</code>
                  <span className="text-zinc-500"> {p.reason}</span>
                </span>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <input
              ref={pathInputRef}
              type="text"
              value={draftPath}
              onChange={(e) => {
                if (pathError) setPathError(null);
                setDraftPath(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleAddProtectedPath();
                }
              }}
              placeholder="/home/user/.ssh"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className={inputClass}
            />
            <button
              type="button"
              onClick={() => void handleAddProtectedPath()}
              disabled={!draftPath.trim()}
              className="flex-shrink-0 rounded-lg bg-zinc-800 px-4 py-2.5 text-sm text-zinc-200 active:bg-zinc-700 disabled:opacity-40"
            >
              添加
            </button>
          </div>
          {pathError && <p className="text-xs text-red-400">{pathError}</p>}
          {customPaths.length === 0 ? (
            <p className="px-1 text-xs italic text-zinc-500">无自定义路径</p>
          ) : (
            <ul className="space-y-1">
              {customPaths.map((p) => (
                <li
                  key={p}
                  className="flex items-center justify-between gap-2 rounded-lg bg-zinc-800 px-3 py-2"
                >
                  <code className="truncate text-xs text-indigo-300">{p}</code>
                  <button
                    type="button"
                    onClick={() =>
                      update({
                        customProtectedPaths: customPaths.filter(
                          (x) => x !== p,
                        ),
                      })
                    }
                    className="flex-shrink-0 p-1 text-zinc-500 active:text-red-400"
                    aria-label={`移除 ${p}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </MobileSettingRow>

      {/* Max rounds */}
      <MobileSettingRow
        label="最大执行轮数"
        description="单次任务最多执行的工具调用轮数，超限自动停止"
        trailing={
          <span className="w-14 text-right font-mono text-sm text-indigo-300">
            {agent.maxToolRounds ?? 80}
          </span>
        }
      >
        <input
          type="range"
          min={10}
          max={300}
          step={10}
          value={agent.maxToolRounds ?? 80}
          onChange={(e) =>
            updateAgent({ maxToolRounds: Number(e.target.value) })
          }
          className="mt-1 h-2 w-full cursor-pointer appearance-none rounded-full bg-zinc-700 accent-indigo-500"
        />
      </MobileSettingRow>

      {/* User system prompt — appended to the agent system prompt (desktop parity) */}
      <MobileSettingRow
        label="用户附加指令"
        description="Agent 调用 LLM 时追加到系统提示词末尾，留空则不注入"
      >
        <textarea
          value={agent.systemPrompt ?? ''}
          onChange={(e) => updateAgent({ systemPrompt: e.target.value })}
          rows={5}
          placeholder="在此输入需要附加到系统提示词中的内容，将在每次 Agent 任务调用 LLM 时生效"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="mt-2 w-full resize-none rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-indigo-500"
        />
      </MobileSettingRow>
    </div>
  );
}
