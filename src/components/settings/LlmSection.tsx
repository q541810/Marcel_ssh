import type { LlmConfig } from '@/lib/types';
import Toggle from '@/components/ui/Toggle';
import { Section, Field } from './helpers';

interface LlmSectionProps {
  llmConfig: LlmConfig | null | undefined;
  updateLlm: (mutator: (l: LlmConfig) => LlmConfig) => void;
  hasStoredApiKey: boolean;
}

export function LlmSection({ llmConfig, updateLlm, hasStoredApiKey }: LlmSectionProps) {
  return (
    <Section
      id="settings-llm"
      title="LLM 配置"
      description="配置 OpenAI 兼容的大语言模型接入。修改后点保存立即生效。"
    >
      <Field label="Provider">
        <select
          value={llmConfig?.providerType ?? 'openai'}
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
          value={llmConfig?.baseUrl ?? ''}
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
          value={llmConfig?.apiKey ?? (hasStoredApiKey ? 'sk-******' : '')}
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
            value={llmConfig?.model ?? ''}
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
          value={llmConfig?.temperature ?? 0.1}
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
      <Field label="TLS">
        <Toggle
          checked={llmConfig?.allowInvalidCerts ?? false}
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
  );
}
