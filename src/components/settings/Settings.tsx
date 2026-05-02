import { useState, useEffect } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import type {
  AppSettings,
  AgentModeSettings,
  CommandListMode,
  LlmConfig,
} from '@/lib/types';
import * as tauri from '@/lib/tauri';
import type { CommandCheckResult } from '@/lib/tauri';
import Button from '@/components/ui/Button';

export default function Settings() {
  const settings = useSettingsStore((s) => s.settings);
  const loaded = useSettingsStore((s) => s.loaded);
  const save = useSettingsStore((s) => s.save);

  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [newCommand, setNewCommand] = useState('');
  const [testCommand, setTestCommand] = useState('');
  const [testResult, setTestResult] = useState<CommandCheckResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [hasStoredApiKey, setHasStoredApiKey] = useState(false);

  // Check if an API key exists in the keychain
  useEffect(() => {
    tauri.getLlmApiKey().then(key => {
      setHasStoredApiKey(!!key);
    }).catch(() => {});
  }, []);

  /**
   * Local "draft" editor state — we hold a working copy and only persist on Save.
   * That way the user can experiment without immediately writing to disk on every
   * keystroke. The store still supports live updates, but the Settings page is a
   * traditional save-on-confirm form.
   */
  const [draft, setDraft] = useState<AppSettings | null>(null);

  // Sync draft from store the first time settings load (or when reset)
  if (loaded && draft === null) {
    setDraft(settings);
  }

  if (!loaded || !draft) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-400">
        加载设置中...
      </div>
    );
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  const updateDraft = (mutator: (s: AppSettings) => AppSettings) => {
    setDraft((cur) => (cur ? mutator(cur) : cur));
  };

  const updateAgent = (mutator: (a: AgentModeSettings) => AgentModeSettings) => {
    updateDraft((s) => ({
      ...s,
      agentModeSettings: mutator(s.agentModeSettings),
    }));
  };

  const updateLlm = (mutator: (l: LlmConfig) => LlmConfig) => {
    updateDraft((s) => ({
      ...s,
      llmConfig: s.llmConfig
        ? mutator(s.llmConfig)
        : mutator({
            providerType: 'openai',
            apiKey: '',
            model: '',
            baseUrl: '',
            maxTokens: 4096,
            temperature: 0.1,
            allowInvalidCerts: false,
          }),
    }));
  };

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    setSavedNotice(null);
    try {
      await save(draft);
      setSavedNotice('设置已保存');
      setTimeout(() => setSavedNotice(null), 2000);
    } catch (err) {
      setSavedNotice(`保存失败：${String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setDraft(settings);
  };

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
      // Always test in AGENT mode since the policy only applies there.
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

  const agent = draft.agentModeSettings;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Page header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-900/50">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-bold text-zinc-100">设置</h1>
          {dirty && (
            <span className="text-xs text-amber-400">有未保存的更改</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {savedNotice && (
            <span className="text-sm text-emerald-400">{savedNotice}</span>
          )}
          {dirty && (
            <Button variant="ghost" onClick={handleReset} disabled={saving}>
              撤销
            </Button>
          )}
          <Button
            variant="primary"
            onClick={handleSave}
            loading={saving}
            disabled={!dirty}
          >
            保存
          </Button>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-6 py-6 max-w-3xl">
        {/* Section: Appearance */}
        <Section title="外观">
          <Field label="主题">
            <select
              value={draft.theme}
              onChange={(e) => updateDraft((s) => ({ ...s, theme: e.target.value }))}
              className="rounded bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
            >
              <option value="dark">深色</option>
              <option value="light">浅色</option>
            </select>
            <span className="text-xs text-zinc-500">应用到终端</span>
          </Field>
          <Field label="字号">
            <input
              type="number"
              min={10}
              max={32}
              value={draft.fontSize}
              onChange={(e) =>
                updateDraft((s) => ({
                  ...s,
                  fontSize: Math.max(10, Math.min(32, parseInt(e.target.value, 10) || 14)),
                }))
              }
              className="w-24 rounded bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
            />
            <span className="text-xs text-zinc-500">应用到终端</span>
          </Field>
          <Field label="字体">
            <input
              type="text"
              value={draft.fontFamily}
              onChange={(e) =>
                updateDraft((s) => ({ ...s, fontFamily: e.target.value }))
              }
              className="flex-1 rounded bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
            />
            <span className="text-xs text-zinc-500">应用到终端</span>
          </Field>
        </Section>

        {/* Section: Agent default mode */}
        <Section title="智能助手">
          <Field label="默认模式">
            <select
              value={draft.defaultAgentMode}
              onChange={(e) =>
                updateDraft((s) => ({ ...s, defaultAgentMode: e.target.value }))
              }
              className="rounded bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
            >
              <option value="chat">CHAT — 纯聊天</option>
              <option value="agent">AGENT — 工具调用 + 黑/白名单</option>
              <option value="auto">AUTO — 完全自主</option>
            </select>
          </Field>
        </Section>

        {/* Section: LLM */}
        <Section
          title="LLM 配置"
          description="配置 OpenAI 兼容的大语言模型接入。修改后点保存立即生效。"
        >
          <Field label="Provider">
            <select
              value={draft.llmConfig?.providerType ?? 'openai'}
              onChange={(e) =>
                updateLlm((l) => ({
                  ...l,
                  providerType: e.target.value as LlmConfig['providerType'],
                }))
              }
              className="rounded bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
            >
              <option value="openai">OpenAI 兼容</option>
              <option value="anthropic" disabled>
                Anthropic (暂未实现)
              </option>
              <option value="ollama" disabled>
                Ollama (暂未实现)
              </option>
            </select>
          </Field>
          <Field label="Base URL">
            <input
              type="text"
              value={draft.llmConfig?.baseUrl ?? ''}
              onChange={(e) =>
                updateLlm((l) => ({ ...l, baseUrl: e.target.value }))
              }
              placeholder="https://api.openai.com/v1"
              className="flex-1 rounded bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500"
            />
          </Field>
          <Field label="API Key">
            <input
              type="password"
              value={draft.llmConfig?.apiKey || (hasStoredApiKey ? 'sk-******' : '')}
              onChange={(e) =>
                updateLlm((l) => ({ ...l, apiKey: e.target.value }))
              }
              placeholder="输入 API Key"
              autoComplete="off"
              className="flex-1 rounded bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500"
            />
          </Field>
          <Field label="Model">
            <div className="flex-1 flex gap-2 items-center">
              <input
                type="text"
                value={draft.llmConfig?.model ?? ''}
                onChange={(e) =>
                  updateLlm((l) => ({ ...l, model: e.target.value }))
                }
                placeholder="claude-opus-4-7"
                list="llm-model-suggestions"
                className="flex-1 rounded bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500"
              />
              <datalist id="llm-model-suggestions">
                <option value="claude-opus-4-7" />
                <option value="claude-opus-4-6-1m" />
              </datalist>
            </div>
          </Field>
          <Field label="温度">
            <input
              type="number"
              step={0.1}
              min={0}
              max={2}
              value={draft.llmConfig?.temperature ?? 0.1}
              onChange={(e) =>
                updateLlm((l) => ({
                  ...l,
                  temperature: Math.max(
                    0,
                    Math.min(2, parseFloat(e.target.value) || 0),
                  ),
                }))
              }
              className="w-24 rounded bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
            />
          </Field>
          <Field label="Max Tokens">
            <input
              type="number"
              min={256}
              max={200000}
              step={256}
              value={draft.llmConfig?.maxTokens ?? 4096}
              onChange={(e) =>
                updateLlm((l) => ({
                  ...l,
                  maxTokens: Math.max(
                    256,
                    Math.min(200000, parseInt(e.target.value, 10) || 4096),
                  ),
                }))
              }
              className="w-32 rounded bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
            />
          </Field>
          <Field label="TLS">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={draft.llmConfig?.allowInvalidCerts ?? false}
                onChange={(e) =>
                  updateLlm((l) => ({
                    ...l,
                    allowInvalidCerts: e.target.checked,
                  }))
                }
                className="w-4 h-4 accent-indigo-500"
              />
              <span className="text-sm text-zinc-300">
                允许自签名/无效证书（用于本地或内网 HTTPS 服务器）
              </span>
            </label>
          </Field>
        </Section>

        {/* Section: AGENT mode command policy */}
        <Section
          title="AGENT 模式 — 命令执行策略"
          description="仅在 AGENT 模式下生效。CHAT 模式不会执行命令；AUTO 模式不受此处限制。"
        >
          <Field label="列表模式">
            <div className="flex rounded overflow-hidden border border-zinc-700">
              <ListModeButton
                value="denylist"
                current={agent.listMode}
                onClick={(v) =>
                  updateAgent((a) => ({ ...a, listMode: v }))
                }
                label="黑名单"
                description="只阻止列表中的命令"
              />
              <ListModeButton
                value="allowlist"
                current={agent.listMode}
                onClick={(v) =>
                  updateAgent((a) => ({ ...a, listMode: v }))
                }
                label="白名单"
                description="只允许列表中的命令"
              />
            </div>
          </Field>

          <Field label="逐条确认">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={agent.confirmEachCommand}
                onChange={(e) =>
                  updateAgent((a) => ({
                    ...a,
                    confirmEachCommand: e.target.checked,
                  }))
                }
                className="w-4 h-4 accent-indigo-500"
              />
              <span className="text-sm text-zinc-300">
                即使通过列表过滤，仍要求用户确认每条命令
              </span>
            </label>
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
                  className="flex-1 rounded bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500"
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
                      className="group inline-flex items-center gap-1.5 px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-xs font-mono text-zinc-200"
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

          {/* Command tester — validates against *saved* settings, so the user
              can immediately confirm their rules work as expected. */}
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
                  className="flex-1 rounded bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500"
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
                    rounded border px-3 py-2 text-sm
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
      </div>
    </div>
  );
}

/* -- helpers -- */

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <h2 className="text-base font-semibold text-zinc-100 mb-1">{title}</h2>
      {description && (
        <p className="text-xs text-zinc-500 mb-3">{description}</p>
      )}
      <div className="space-y-3 mt-3">{children}</div>
    </section>
  );
}

function Field({
  label,
  children,
  alignTop,
}: {
  label: string;
  children: React.ReactNode;
  alignTop?: boolean;
}) {
  return (
    <div
      className={`flex gap-4 ${alignTop ? 'items-start' : 'items-center'}`}
    >
      <label
        className={`w-32 flex-shrink-0 text-sm text-zinc-300 ${
          alignTop ? 'pt-1.5' : ''
        }`}
      >
        {label}
      </label>
      <div className="flex-1 flex items-center gap-2 min-w-0">{children}</div>
    </div>
  );
}

function ListModeButton({
  value,
  current,
  onClick,
  label,
  description,
}: {
  value: CommandListMode;
  current: CommandListMode;
  onClick: (v: CommandListMode) => void;
  label: string;
  description: string;
}) {
  const active = value === current;
  return (
    <button
      onClick={() => onClick(value)}
      title={description}
      className={`
        px-4 py-2 text-sm transition-colors
        ${
          active
            ? 'bg-indigo-600 text-white'
            : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
        }
      `}
    >
      {label}
    </button>
  );
}
