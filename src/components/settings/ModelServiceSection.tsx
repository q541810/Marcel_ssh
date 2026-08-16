import { useState, useEffect, useMemo, useRef } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import type { LlmConfig, AgentModeSettings } from '@/lib/types';
import Toggle from '@/components/ui/Toggle';
import Select from '@/components/ui/Select';
import { Card, SettingItem } from './helpers';
import { ValidatedInput } from './ValidatedInput';
import { useSettingsActions } from './SettingsActionsContext';
import { contextWindowHint } from '@/lib/contextWindowHints';
import ModelListModal from './ModelListModal';

/** Validate that `extraBody` is a valid JSON object. Returns null on success. */
export function validateExtraBodyJson(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null; // empty = "not set" = valid
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return `JSON 解析失败：${e instanceof Error ? e.message : String(e)}`;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return '必须是 JSON 对象（{}），不能是数组、null 或基本类型';
  }
  return null;
}

/**
 * Convert LlmConfig.extraBody to a text representation for the textarea.
 *
 * Only `null` / `undefined` (not set) collapses to an empty string.
 * An empty object `{}` is a legitimate user choice and is preserved as `'{}'`
 * — the backend treats it as a no-op (`extra_body_empty_object_is_noop` in
 * `openai.rs`) and the validator explicitly accepts `{}` as valid JSON.
 * Collapsing `{}` to `''` would silently discard the user's input via the
 * `useEffect` text sync.
 */
export function extraBodyToText(extraBody: LlmConfig['extraBody']): string {
  if (extraBody == null) return '';
  return JSON.stringify(extraBody, null, 2);
}

/** Parse textarea text back to extraBody value. Empty/invalid → null (not set). */
export function textToExtraBody(text: string): LlmConfig['extraBody'] {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const parsed = JSON.parse(trimmed);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

const EXTRA_BODY_PLACEHOLDER = `{
  "thinking": { "type": "enabled" },
  "top_p": 0.9,
  "max_tokens": 4096
}`;

export function ModelServiceSection() {
  const { settings, update, registerValidator, clearValidationErrors } = useSettingsActions();
  const hasApiKey = useSettingsStore((s) => s.hasApiKey);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [extraBodyOpen, setExtraBodyOpen] = useState(false);
  const [extraBodyText, setExtraBodyText] = useState(() => extraBodyToText(settings.llmConfig?.extraBody));
  const [extraBodyError, setExtraBodyError] = useState<string | null>(null);
  // 标记「下一次 extraBody 变化是用户输入触发的」——useEffect 看到此标记会跳过
  // 反向同步，避免 JSON.stringify 重写用户原文（空格/换行/缩进）。
  // 受 AgentPolicySection 草稿模式启发：用户输入期间永远赢；sync 推送过来
  // 的更新正常反向同步。
  const userInputPendingRef = useRef(false);

  const llmConfig: LlmConfig = settings.llmConfig ?? {
    providerType: 'openai',
    apiKey: '',
    model: '',
    baseUrl: '',
    temperature: 0.1,
    maxRetries: 1,
    retryDelaySecs: 5,
    retryHttpStatuses: '408, 429, 500-599',
    vision: false,
    extraBody: null,
  };

  // 同步 draft → textarea：仅同步「非用户输入触发」的变化（sync 推送、重置等）。
  // 用户输入触发的 update 由 userInputPendingRef 标记，useEffect 看到标记会跳过，
  // 避免 JSON.stringify 重写用户原文（空格/换行/缩进）。
  useEffect(() => {
    if (userInputPendingRef.current) {
      userInputPendingRef.current = false;
      return;
    }
    const fromSettings = extraBodyToText(llmConfig.extraBody);
    setExtraBodyText((prev) => (prev === fromSettings ? prev : fromSettings));
  }, [llmConfig.extraBody]);

  // 文本 → draft：用户编辑后实时同步到 draft，让 validator 知道当前值。
  // 解析失败时不动 draft（保持旧值），并设置本地 error（不阻断输入）。
  // 保存校验由下面注册到 SettingsActionsContext 的 validator 负责。
  const handleExtraBodyChange = (text: string) => {
    setExtraBodyText(text);
    const err = validateExtraBodyJson(text);
    setExtraBodyError(err);
    if (err === null) {
      const next = textToExtraBody(text);
      if (next !== llmConfig.extraBody) {
        userInputPendingRef.current = true;
        update({ llmConfig: { ...llmConfig, extraBody: next } });
      }
      clearValidationErrors();
    }
  };

  // 注册保存时校验：阻断非法 JSON 通过保存按钮溜走。
  // 兜底检查：text 与 draft 不一致（多见于 sync 推送过来但 textarea 草稿还在），
  // 提示用户重新输入。
  useEffect(() => {
    return registerValidator('llmConfig.extraBody', (draft) => {
      const text = extraBodyText;
      const err = validateExtraBodyJson(text);
      if (err) return `高级参数 JSON 不合法：${err}`;
      const draftExtra = draft.llmConfig?.extraBody;
      if (text.trim() === '' && draftExtra != null && Object.keys(draftExtra).length > 0) {
        return '高级参数存在不一致，请重新输入';
      }
      return null;
    });
  }, [registerValidator, extraBodyText]);

  const updateLlm = (patch: Partial<LlmConfig>) => {
    update({ llmConfig: { ...llmConfig, ...patch } });
  };

  const extraBodySummary = useMemo(() => {
    const body = llmConfig.extraBody;
    if (body == null) return '未设置';
    const count = Object.keys(body).length;
    return count === 0 ? '空对象 {}' : `${count} 个参数`;
  }, [llmConfig.extraBody]);

  return (
    <Card id="settings-llm" title="模型服务" description="配置 OpenAI 兼容的大语言模型接入">
      <SettingItem id="llm-provider" label="Provider" description="选择 LLM 提供商" sectionId="settings-llm" keywords={['provider', '模型提供商', '模型服务']}>
        <Select
          value={llmConfig.providerType}
          onChange={(v) => updateLlm({ providerType: v as LlmConfig['providerType'] })}
          options={[
            { value: 'openai', label: 'OpenAI 兼容' },
            { value: 'anthropic', label: 'Anthropic (暂未实现)', disabled: true },
            { value: 'ollama', label: 'Ollama (暂未实现)', disabled: true },
          ]}
          className="w-52"
        />
      </SettingItem>
      <SettingItem id="llm-baseurl" label="Base URL" description="API 基础地址" sectionId="settings-llm" keywords={['url', '地址', '模型服务']}>
        <input
          type="text"
          value={llmConfig.baseUrl ?? ''}
          onChange={(e) => updateLlm({ baseUrl: e.target.value || null })}
          placeholder="https://api.openai.com/v1"
          className="flex-1 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500"
        />
      </SettingItem>
      <SettingItem id="llm-apikey" label="API Key" description="API 密钥" sectionId="settings-llm" keywords={['key', '密钥', 'token', '模型服务']}>
        <input
          type="password"
          value={llmConfig.apiKey ?? (hasApiKey ? 'sk-******' : '')}
          onChange={(e) => updateLlm({ apiKey: e.target.value })}
          placeholder="输入 API Key"
          autoComplete="off"
          className="flex-1 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500"
        />
      </SettingItem>
      <SettingItem id="llm-model" label="Model" description="模型名称" sectionId="settings-llm" keywords={['model', '模型', '模型服务']}>
        <div className="flex-1 flex gap-2 items-center">
          <input
            type="text"
            value={llmConfig.model}
            onChange={(e) => updateLlm({ model: e.target.value })}
            placeholder="claude-opus-4-7"
            list="llm-model-suggestions"
            className="flex-1 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500"
          />
          <datalist id="llm-model-suggestions">
            <option value="claude-opus-4-7" />
            <option value="claude-opus-4-6-1m" />
          </datalist>
          <button
            type="button"
            onClick={() => setModelsOpen(true)}
            className="px-2.5 py-1.5 rounded-lg text-xs text-zinc-300 bg-zinc-800 hover:bg-zinc-700 transition-colors"
          >
            获取模型列表
          </button>
        </div>
      </SettingItem>
      <SettingItem id="llm-vision" label="视觉 / 支持图片" description="开启后可粘贴或拖入图片发给模型（需模型本身支持多模态）" sectionId="settings-llm" keywords={['vision', '视觉', '图片', 'image', '多模态']}>
        <Toggle
          checked={llmConfig.vision ?? false}
          onChange={(checked) => updateLlm({ vision: checked })}
          label="允许向模型发送图片（Ctrl+V / 拖拽）"
        />
      </SettingItem>
      <SettingItem id="llm-context-window" label="模型上下文窗口 (tokens)" description="留空或 0 = 仅在模型报告上下文超限时压缩旧历史；填写后按窗口的 80% 阈值预防式压缩" sectionId="settings-llm" keywords={['context', '上下文', 'token', '窗口', 'window', '压缩', 'compaction']}>
        <ValidatedInput
          type="number"
          value={settings.agentModeSettings?.contextWindow ?? 0}
          onChange={(v) => update({ agentModeSettings: { ...(settings.agentModeSettings ?? {}), contextWindow: v } as AgentModeSettings })}
          validate={(s) => {
            const v = Number(s);
            // 无硬上限（未来超大窗口模型可配）；仅要求非负整数
            if (!Number.isInteger(v) || v < 0) return '须为非负整数（0 = 不启用预防式压缩）';
            return null;
          }}
          validatorId="contextWindow"
          validatorFn={(draft) => {
            const v = draft.agentModeSettings?.contextWindow;
            if (v === undefined) return null;
            if (!Number.isInteger(v) || v < 0) return `模型上下文窗口须为非负整数（当前值：${v}）`;
            return null;
          }}
          hint={contextWindowHint(settings.agentModeSettings?.contextWindow)}
          min={0} step={1000}
          suffix="tokens"
          className="w-32"
        />
      </SettingItem>

      {/* 高级：自定义请求参数（extra_body）。折叠默认关，避免主页面太长。 */}
      <div className="px-6 py-4">
        <button
          type="button"
          onClick={() => setExtraBodyOpen((o) => !o)}
          className="flex items-center gap-2 text-sm font-medium text-zinc-200 hover:text-zinc-100 transition-colors w-full"
          aria-expanded={extraBodyOpen}
        >
          <svg
            className={`w-3.5 h-3.5 transition-transform ${extraBodyOpen ? 'rotate-90' : ''}`}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 4l4 4-4 4" />
          </svg>
          <span>高级：自定义请求参数</span>
          <span className="text-[11px] text-zinc-500 font-normal ml-1">（{extraBodySummary}）</span>
        </button>
        {extraBodyOpen && (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-zinc-500 leading-relaxed">
              以 JSON 对象形式追加任意参数到 LLM 请求体（如 <code className="font-mono text-zinc-400">thinking</code>、<code className="font-mono text-zinc-400">top_p</code>、<code className="font-mono text-zinc-400">max_tokens</code>、<code className="font-mono text-zinc-400">seed</code>）。
              此处键值会<strong className="text-zinc-300">覆盖</strong>上方的类型化字段（如 <code className="font-mono text-zinc-400">temperature</code>），用于接入未在 UI 暴露的 provider 私有参数。
              执行前模型审批的 LLM 调用<strong className="text-zinc-300">不会</strong>带这些参数。
            </p>
            <textarea
              value={extraBodyText}
              onChange={(e) => handleExtraBodyChange(e.target.value)}
              placeholder={EXTRA_BODY_PLACEHOLDER}
              spellCheck={false}
              rows={8}
              className={`w-full rounded-lg px-3 py-2 text-xs font-mono text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500 resize-y ${
                extraBodyError ? 'bg-red-900/20 border border-red-500/50' : 'bg-zinc-800 border border-zinc-700'
              }`}
            />
            {extraBodyError && (
              <p className="text-xs text-red-400">{extraBodyError}</p>
            )}
          </div>
        )}
      </div>

      <ModelListModal
        open={modelsOpen}
        onClose={() => setModelsOpen(false)}
        currentModel={llmConfig.model}
        baseUrl={llmConfig.baseUrl}
        apiKey={llmConfig.apiKey}
        onSelect={(id) => updateLlm({ model: id })}
      />
    </Card>
  );
}
