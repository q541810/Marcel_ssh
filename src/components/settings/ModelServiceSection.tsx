import { useState } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import type { LlmConfig, AgentModeSettings } from '@/lib/types';
import Toggle from '@/components/ui/Toggle';
import { Card, SettingItem } from './helpers';
import { useSettingsActions } from './SettingsActionsContext';
import ModelListModal from './ModelListModal';

export function ModelServiceSection() {
  const { settings, update } = useSettingsActions();
  const hasApiKey = useSettingsStore((s) => s.hasApiKey);
  const [modelsOpen, setModelsOpen] = useState(false);

  const llmConfig: LlmConfig = settings.llmConfig ?? {
    providerType: 'openai',
    apiKey: '',
    model: '',
    baseUrl: '',
    temperature: 0.1,
    maxRetries: 1,
    retryDelaySecs: 5,
    retryHttpStatuses: '408, 429, 500-599',
  };

  const updateLlm = (patch: Partial<LlmConfig>) => {
    update({ llmConfig: { ...llmConfig, ...patch } });
  };

  return (
    <Card id="settings-llm" title="模型服务" description="配置 OpenAI 兼容的大语言模型接入">
      <SettingItem id="llm-provider" label="Provider" description="选择 LLM 提供商" sectionId="settings-llm" keywords={['provider', '模型提供商', '模型服务']}>
        <select
          value={llmConfig.providerType}
          onChange={(e) => updateLlm({ providerType: e.target.value as LlmConfig['providerType'] })}
          className="rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
        >
          <option value="openai">OpenAI 兼容</option>
          <option value="anthropic" disabled>Anthropic (暂未实现)</option>
          <option value="ollama" disabled>Ollama (暂未实现)</option>
        </select>
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
      <SettingItem id="llm-compact-context" label="压缩上下文" description="历史累积 token 过多时自动裁剪旧工具结果" sectionId="settings-llm" keywords={['compact', '压缩', 'token', '上下文']}>
        <Toggle
          checked={settings.agentModeSettings?.compactContext ?? false}
          onChange={(checked) => update({ agentModeSettings: { ...(settings.agentModeSettings ?? {}), compactContext: checked } as AgentModeSettings })}
          label="上下文超过 80k tokens 且对话超过 5 轮时截断超长结果；超过 130k tokens 时清除旧结果"
        />
      </SettingItem>
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
