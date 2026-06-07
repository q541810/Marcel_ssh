import { useSettingsStore } from '@/stores/settingsStore';
import Toggle from '@/components/ui/Toggle';
import type { LlmConfig } from '@/lib/types';
import { Card, SettingItem } from './helpers';
import { useSettingsActions } from './SettingsActionsContext';

export function ModelServiceSection() {
  const { settings, update } = useSettingsActions();
  const hasApiKey = useSettingsStore((s) => s.hasApiKey);

  const llmConfig: LlmConfig = settings.llmConfig ?? {
    providerType: 'openai',
    apiKey: '',
    model: '',
    baseUrl: '',
    temperature: 0.1,
    allowInvalidCerts: false,
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
        </div>
      </SettingItem>
      <SettingItem id="llm-temperature" label="温度" description="采样温度 (0-2)" sectionId="settings-llm" keywords={['temperature', '采样', '随机性']}>
        <input
          type="number"
          step={0.1}
          min={0}
          max={2}
          value={llmConfig.temperature}
          onChange={(e) => updateLlm({ temperature: Math.max(0, Math.min(2, parseFloat(e.target.value) || 0)) })}
          className="w-24 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
        />
      </SettingItem>
      <SettingItem id="llm-tls" label="TLS" description="证书验证设置" sectionId="settings-llm" keywords={['tls', 'ssl', 'certificate', '证书']}>
        <Toggle
          checked={llmConfig.allowInvalidCerts}
          onChange={(checked) => updateLlm({ allowInvalidCerts: checked })}
          label="允许自签名/无效证书（用于本地或内网 HTTPS 服务器）"
        />
      </SettingItem>
    </Card>
  );
}
