import { useState, useEffect, useRef } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import type {
  AppSettings,
  AgentModeSettings,
  CommandListMode,
  LlmConfig,
  TerminalColors,
} from '@/lib/types';
import * as tauri from '@/lib/tauri';
import type { CommandCheckResult } from '@/lib/tauri';
import { TERMINAL_COLOR_PRESETS } from '@/lib/constants';
import Button from '@/components/ui/Button';
import Toggle from '@/components/ui/Toggle';

export default function Settings() {
  const settings = useSettingsStore((s) => s.settings);
  const loaded = useSettingsStore((s) => s.loaded);
  const save = useSettingsStore((s) => s.save);
  const setPreview = useSettingsStore((s) => s.setPreview);
  const clearPreview = useSettingsStore((s) => s.clearPreview);

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

  // Sync draft from store the first time settings load
  useEffect(() => {
    if (loaded && draft === null) {
      setDraft(settings);
    }
  }, [loaded, draft, settings]);

  if (!loaded || !draft) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-400">
        加载设置中...
      </div>
    );
  }

  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(settings);

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
    clearPreview();
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
      <div className="flex-1 overflow-y-auto">
        <div className="px-6 py-6">
          {/* Section: Appearance */}
        <Section title="外观">
          <Field label="终端颜色">
            <ColorThemeSelector
              value={draft.terminalColors}
              onChange={(terminalColors) => {
                updateDraft((s) => ({ ...s, terminalColors }));
                setPreview({ terminalColors });
              }}
            />
          </Field>
          <Field label="字号">
            <FontSizeInput
              value={draft.fontSize}
              onChange={(fontSize) => {
                updateDraft((s) => ({ ...s, fontSize }));
                setPreview({ fontSize });
              }}
            />
          </Field>
          <Field label="字体">
            <input
              type="text"
              value={draft.fontFamily}
              onChange={(e) => {
                const fontFamily = e.target.value;
                updateDraft((s) => ({ ...s, fontFamily }));
                setPreview({ fontFamily });
              }}
              className="flex-1 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
            />
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
              className="rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
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
              className="rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
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
              className="flex-1 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500"
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
              className="flex-1 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500"
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
                className="flex-1 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500"
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
              className="w-24 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
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
              className="w-32 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
            />
          </Field>
          <Field label="TLS">
            <Toggle
              checked={draft.llmConfig?.allowInvalidCerts ?? false}
              onChange={(checked) =>
                updateLlm((l) => ({
                  ...l,
                  allowInvalidCerts: checked,
                }))
              }
              label="允许自签名/无效证书（用于本地或内网 HTTPS 服务器）"
            />
          </Field>
        </Section>

        {/* Section: AGENT mode command policy */}
        <Section
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
        </div>
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

function FontSizeInput({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  const [showSlider, setShowSlider] = useState(false);
  const [inputValue, setInputValue] = useState(String(value));
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setInputValue(String(value));
  }, [value]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setShowSlider(false);
      }
    }
    if (showSlider) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showSlider]);

  const handleBlur = () => {
    const num = parseInt(inputValue, 10);
    const clamped = Math.max(10, Math.min(32, num || 14));
    setInputValue(String(clamped));
    if (clamped !== value) {
      onChange(clamped);
    }
  };

  return (
    <div ref={containerRef} className="relative inline-block">
      <input
        type="number"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onFocus={() => setShowSlider(true)}
        onBlur={handleBlur}
        className="w-24 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      />
      {showSlider && (
        <div 
          className="absolute top-full left-1/2 -translate-x-1/2 mt-2 p-3 bg-zinc-800 border border-zinc-700 rounded-xl shadow-xl z-50 w-52 animate-slide-down"
          style={{ animationDuration: '200ms', animationTimingFunction: 'var(--spring-bounce)' }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <input
            type="range"
            min={10}
            max={32}
            value={value}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (v !== value) {
                setInputValue(String(v));
                onChange(v);
              }
            }}
            className="w-full h-2 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
          />
          <div className="flex justify-between text-xs text-zinc-500 mt-1">
            <span>10</span>
            <span className="text-indigo-400 font-medium">{value}px</span>
            <span>32</span>
          </div>
        </div>
      )}
    </div>
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

const COLOR_FIELDS: { key: keyof TerminalColors; label: string }[] = [
  { key: 'background', label: '背景' },
  { key: 'foreground', label: '前景' },
  { key: 'cursor', label: '光标' },
  { key: 'selectionBackground', label: '选区' },
  { key: 'black', label: '黑' },
  { key: 'red', label: '红' },
  { key: 'green', label: '绿' },
  { key: 'yellow', label: '黄' },
  { key: 'blue', label: '蓝' },
  { key: 'magenta', label: '品红' },
  { key: 'cyan', label: '青' },
  { key: 'white', label: '白' },
  { key: 'brightBlack', label: '亮黑' },
  { key: 'brightRed', label: '亮红' },
  { key: 'brightGreen', label: '亮绿' },
  { key: 'brightYellow', label: '亮黄' },
  { key: 'brightBlue', label: '亮蓝' },
  { key: 'brightMagenta', label: '亮品红' },
  { key: 'brightCyan', label: '亮青' },
  { key: 'brightWhite', label: '亮白' },
];

function ColorThemeSelector({
  value,
  onChange,
}: {
  value: TerminalColors;
  onChange: (colors: TerminalColors) => void;
}) {
  const [showCustom, setShowCustom] = useState(false);
  const [customColors, setCustomColors] = useState<TerminalColors>(value);

  useEffect(() => {
    setCustomColors(value);
  }, [value]);

  const handlePresetSelect = (preset: TerminalColors) => {
    onChange(preset);
    setShowCustom(false);
  };

  const handleCustomChange = (key: keyof TerminalColors, color: string) => {
    const newColors = { ...customColors, [key]: color };
    setCustomColors(newColors);
    onChange(newColors);
  };

  const isPresetSelected = (preset: TerminalColors) => {
    return JSON.stringify(preset) === JSON.stringify(value);
  };

  return (
    <div className="flex-1 space-y-3">
      <div className="flex flex-wrap gap-2">
        {TERMINAL_COLOR_PRESETS.map((preset) => (
          <button
            key={preset.name}
            onClick={() => handlePresetSelect(preset.colors)}
            className={`
              px-3 py-1.5 rounded-lg text-sm transition-all
              ${isPresetSelected(preset.colors)
                ? 'bg-indigo-600 text-white ring-2 ring-indigo-400'
                : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 border border-zinc-700'
              }
            `}
          >
            <span className="flex items-center gap-2">
              <span
                className="w-4 h-4 rounded border border-zinc-600"
                style={{ backgroundColor: preset.colors.background }}
              />
              {preset.name}
            </span>
          </button>
        ))}
        <button
          onClick={() => setShowCustom(!showCustom)}
          className={`
            px-3 py-1.5 rounded-lg text-sm transition-all
            ${showCustom
              ? 'bg-indigo-600 text-white ring-2 ring-indigo-400'
              : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 border border-zinc-700'
            }
          `}
        >
          自定义
        </button>
      </div>

      {showCustom && (
        <div className="p-4 bg-zinc-800/50 rounded-xl border border-zinc-700 space-y-3">
          <div className="text-xs text-zinc-400 mb-2">点击颜色块选择颜色，或直接输入十六进制颜色值</div>
          <div className="grid grid-cols-4 gap-2">
            {COLOR_FIELDS.map(({ key, label }) => (
              <div key={key} className="flex items-center gap-2">
                <label className="text-xs text-zinc-400 w-12">{label}</label>
                <div className="relative flex-1">
                  <input
                    type="color"
                    value={customColors[key]}
                    onChange={(e) => handleCustomChange(key, e.target.value)}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                  <div
                    className="w-full h-6 rounded border border-zinc-600 cursor-pointer"
                    style={{ backgroundColor: customColors[key] }}
                  />
                </div>
                <input
                  type="text"
                  value={customColors[key]}
                  onChange={(e) => handleCustomChange(key, e.target.value)}
                  className="w-20 px-2 py-1 text-xs bg-zinc-900 border border-zinc-700 rounded text-zinc-300 font-mono"
                  placeholder="#000000"
                />
              </div>
            ))}
          </div>
          <div className="pt-2 border-t border-zinc-700">
            <div className="text-xs text-zinc-500 mb-2">预览</div>
            <div
              className="p-3 rounded-lg font-mono text-sm"
              style={{
                backgroundColor: customColors.background,
                color: customColors.foreground,
              }}
            >
              <div className="flex gap-2 mb-1">
                <span style={{ color: customColors.red }}>错误</span>
                <span style={{ color: customColors.green }}>成功</span>
                <span style={{ color: customColors.yellow }}>警告</span>
                <span style={{ color: customColors.blue }}>信息</span>
              </div>
              <div style={{ color: customColors.cyan }}>user@host:~$</div>
              <div>ls -la</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
