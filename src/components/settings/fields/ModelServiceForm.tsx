import type { LlmConfig } from '@/lib/types';

interface ModelServiceFormProps {
  value: LlmConfig;
  hasApiKey: boolean;
  onChange: (patch: Partial<LlmConfig>) => void;
  idPrefix?: string;
}

export function ModelServiceForm({ value, hasApiKey, onChange, idPrefix = '' }: ModelServiceFormProps) {
  const llmConfig = value;
  const datalistId = `${idPrefix}llm-model-suggestions`;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 divide-y divide-zinc-800">
      <div className="px-6 py-4">
        <div className="flex items-center gap-6">
          <div className="flex-shrink-0 w-32 text-sm font-medium text-zinc-200">Provider</div>
          <select
            value={llmConfig.providerType}
            onChange={(e) => onChange({ providerType: e.target.value as LlmConfig['providerType'] })}
            className="rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
          >
            <option value="openai">OpenAI 兼容</option>
            <option value="anthropic" disabled>Anthropic (暂未实现)</option>
            <option value="ollama" disabled>Ollama (暂未实现)</option>
          </select>
        </div>
      </div>

      <div className="px-6 py-4">
        <div className="flex items-center gap-6">
          <div className="flex-shrink-0 w-32 text-sm font-medium text-zinc-200">Base URL</div>
          <input
            type="text"
            value={llmConfig.baseUrl ?? ''}
            onChange={(e) => onChange({ baseUrl: e.target.value || null })}
            placeholder="https://api.openai.com/v1"
            className="flex-1 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500"
          />
        </div>
      </div>

      <div className="px-6 py-4">
        <div className="flex items-center gap-6">
          <div className="flex-shrink-0 w-32 text-sm font-medium text-zinc-200">API Key</div>
          <input
            type="password"
            value={llmConfig.apiKey ?? (hasApiKey ? 'sk-******' : '')}
            onChange={(e) => onChange({ apiKey: e.target.value })}
            placeholder="输入 API Key"
            autoComplete="off"
            className="flex-1 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500"
          />
        </div>
      </div>

      <div className="px-6 py-4">
        <div className="flex items-center gap-6">
          <div className="flex-shrink-0 w-32 text-sm font-medium text-zinc-200">Model</div>
          <div className="flex-1 flex gap-2 items-center">
            <input
              type="text"
              value={llmConfig.model}
              onChange={(e) => onChange({ model: e.target.value })}
              placeholder="claude-opus-4-7"
              list={datalistId}
              className="flex-1 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500"
            />
            <datalist id={datalistId}>
              <option value="claude-opus-4-7" />
              <option value="claude-opus-4-6-1m" />
            </datalist>
          </div>
        </div>
      </div>
    </div>
  );
}
