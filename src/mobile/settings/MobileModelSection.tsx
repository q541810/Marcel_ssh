import { useCallback, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import type { AgentModeSettings, LlmConfig, ModelInfo } from '@/lib/types';
import { llmListModels } from '@/lib/tauri';
import { getErrorMessage } from '@/lib/errors';
import Toggle from '@/components/ui/Toggle';
import { useSettingsActions } from '@/components/settings/SettingsActionsContext';
import { validateRetryHttpStatuses } from '@/components/settings/ModelRetrySection';
import { contextWindowHint } from '@/lib/contextWindowHints';
import MobileSheet from '../ui/MobileSheet';
import { MobileSettingRow } from './MobileSettingRow';

const DEFAULT_LLM: LlmConfig = {
  providerType: 'openai',
  apiKey: '',
  model: '',
  baseUrl: '',
  temperature: 0.1,
  maxRetries: 1,
  retryDelaySecs: 5,
  retryHttpStatuses: '408, 429, 500-599',
  vision: false,
};

/** Touch-first LLM settings for the mobile shell (OpenAI-compatible only, like desktop). */
export function MobileModelSection() {
  const { settings, update } = useSettingsActions();
  const hasApiKey = useSettingsStore((s) => s.hasApiKey);

  const llmConfig: LlmConfig = settings.llmConfig ?? DEFAULT_LLM;
  const updateLlm = (patch: Partial<LlmConfig>) => {
    update({ llmConfig: { ...llmConfig, ...patch } });
  };

  // Draft for retryHttpStatuses: keep invalid text editable locally,
  // only persist when it passes the shared desktop validator.
  const [statusesDraft, setStatusesDraft] = useState<string | null>(null);
  const statusesText = statusesDraft ?? llmConfig.retryHttpStatuses;
  const statusesError =
    statusesDraft != null ? validateRetryHttpStatuses(statusesDraft) : null;

  const [modelsOpen, setModelsOpen] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [filter, setFilter] = useState('');

  const fetchModels = useCallback(async () => {
    setModelsLoading(true);
    setModelsError(null);
    try {
      const list = await llmListModels(llmConfig.baseUrl, llmConfig.apiKey);
      list.sort((a, b) => a.id.localeCompare(b.id));
      setModels(list);
    } catch (err) {
      setModelsError(getErrorMessage(err));
    } finally {
      setModelsLoading(false);
    }
  }, [llmConfig.baseUrl, llmConfig.apiKey]);

  const openModels = () => {
    setModelsOpen(true);
    setFilter('');
    void fetchModels();
  };

  const filterText = filter.trim().toLowerCase();
  const filtered =
    filterText === ''
      ? models
      : models.filter((m) => m.id.toLowerCase().includes(filterText));

  const inputClass =
    'mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-indigo-500';

  return (
    <div className="flex flex-col gap-2">
      <MobileSettingRow label="Base URL" description="OpenAI 兼容 API 基础地址">
        <input
          type="url"
          inputMode="url"
          value={llmConfig.baseUrl ?? ''}
          onChange={(e) => updateLlm({ baseUrl: e.target.value || null })}
          placeholder="https://api.openai.com/v1"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className={inputClass}
        />
      </MobileSettingRow>

      <MobileSettingRow
        label="API Key"
        description="API 密钥，加密保存在本设备"
      >
        <input
          type="password"
          value={llmConfig.apiKey ?? (hasApiKey ? 'sk-******' : '')}
          onChange={(e) => updateLlm({ apiKey: e.target.value })}
          placeholder="输入 API Key"
          autoComplete="off"
          className={inputClass}
        />
      </MobileSettingRow>

      <MobileSettingRow label="Model" description="模型名称">
        <input
          type="text"
          value={llmConfig.model}
          onChange={(e) => updateLlm({ model: e.target.value })}
          placeholder="claude-opus-4-7"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className={inputClass}
        />
        <button
          type="button"
          onClick={openModels}
          className="mt-2 w-full rounded-lg bg-zinc-800 px-3 py-2.5 text-sm text-zinc-200 active:bg-zinc-700"
        >
          获取模型列表
        </button>
      </MobileSettingRow>

      <MobileSettingRow
        label="视觉 / 支持图片"
        description="开启后可发送图片给模型（需模型支持多模态）"
        trailing={
          <Toggle
            checked={llmConfig.vision ?? false}
            onChange={(checked) => updateLlm({ vision: checked })}
          />
        }
      />

      <MobileSettingRow
        label="模型上下文窗口 (tokens)"
        description="留空或 0 = 仅在模型报告上下文超限时压缩旧历史；填写后按窗口的 80% 阈值预防式压缩"
      >
        <div className="w-full space-y-1">
          <input
            type="number"
            inputMode="numeric"
            min={0}
            step={1000}
            value={settings.agentModeSettings?.contextWindow ?? 0}
            onChange={(e) => {
              const v = Math.max(0, Math.trunc(Number(e.target.value) || 0));
              update({
                agentModeSettings: {
                  ...(settings.agentModeSettings ?? {}),
                  contextWindow: v,
                } as AgentModeSettings,
              });
            }}
            placeholder="0 = 仅超限后压缩"
            className={inputClass}
          />
          {(() => {
            const hint = contextWindowHint(settings.agentModeSettings?.contextWindow);
            return hint ? (
              <p className="text-xs leading-relaxed text-zinc-500">{hint}</p>
            ) : null;
          })()}
        </div>
      </MobileSettingRow>

      {/* Request retry — mirrors desktop ModelRetrySection (0-10 retries, 1-60s delay) */}
      <MobileSettingRow
        label="最大重试次数"
        description="LLM 请求失败时自动重试的最大次数（0 = 不重试）"
        trailing={
          <span className="w-14 text-right font-mono text-sm text-indigo-300">
            {llmConfig.maxRetries} 次
          </span>
        }
      >
        <input
          type="range"
          min={0}
          max={10}
          step={1}
          value={llmConfig.maxRetries}
          onChange={(e) => updateLlm({ maxRetries: Number(e.target.value) })}
          className="mt-1 h-2 w-full cursor-pointer appearance-none rounded-full bg-zinc-700 accent-indigo-500"
        />
      </MobileSettingRow>

      <MobileSettingRow
        label="重试间隔"
        description="两次重试之间的等待时间"
        trailing={
          <span className="w-14 text-right font-mono text-sm text-indigo-300">
            {llmConfig.retryDelaySecs}s
          </span>
        }
      >
        <input
          type="range"
          min={1}
          max={60}
          step={1}
          value={llmConfig.retryDelaySecs}
          onChange={(e) =>
            updateLlm({ retryDelaySecs: Number(e.target.value) })
          }
          className="mt-1 h-2 w-full cursor-pointer appearance-none rounded-full bg-zinc-700 accent-indigo-500"
        />
      </MobileSettingRow>

      <MobileSettingRow
        label="重试条件"
        description="逗号分隔的 HTTP 状态码或范围（如 408, 429, 500-599）。匹配到对应状态码时触发重试；网络/超时错误始终重试。"
      >
        <input
          type="text"
          inputMode="numeric"
          value={statusesText}
          onChange={(e) => {
            const v = e.target.value;
            setStatusesDraft(v);
            if (validateRetryHttpStatuses(v) === null) {
              updateLlm({ retryHttpStatuses: v });
            }
          }}
          onBlur={() => {
            if (statusesDraft != null && statusesError === null) {
              setStatusesDraft(null);
            }
          }}
          placeholder="408, 429, 500-599"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className={inputClass}
        />
        {statusesError && (
          <p className="mt-1 text-xs text-red-400">{statusesError}</p>
        )}
      </MobileSettingRow>

      {/* Model picker sheet */}
      <MobileSheet
        open={modelsOpen}
        onClose={() => setModelsOpen(false)}
        title="选择模型"
        maxHeightClassName="max-h-[min(75dvh,calc(100dvh-var(--ime-bottom,0px)))]"
      >
        <div className="flex flex-col gap-2 px-4 pb-4">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="过滤模型 ID…"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-indigo-500"
          />

          {modelsLoading && (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在从供应商获取…
            </div>
          )}

          {!modelsLoading && modelsError && (
            <div className="space-y-3 py-4">
              <p className="break-words text-sm text-red-400">{modelsError}</p>
              <button
                type="button"
                onClick={() => void fetchModels()}
                className="w-full rounded-lg bg-zinc-800 px-3 py-2.5 text-sm text-zinc-200 active:bg-zinc-700"
              >
                重试
              </button>
            </div>
          )}

          {!modelsLoading && !modelsError && filtered.length === 0 && (
            <p className="py-10 text-center text-sm text-zinc-500">
              {models.length === 0 ? '供应商未返回任何模型' : '无匹配模型'}
            </p>
          )}

          {!modelsLoading && !modelsError && filtered.length > 0 && (
            <ul className="divide-y divide-zinc-800 overflow-hidden rounded-xl border border-zinc-800">
              {filtered.map((m) => {
                const isCurrent = m.id === llmConfig.model;
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => {
                        updateLlm({ model: m.id });
                        setModelsOpen(false);
                      }}
                      className={`flex w-full items-center gap-2 px-3 py-3 text-left font-mono text-sm ${
                        isCurrent
                          ? 'bg-indigo-600/10 text-indigo-300'
                          : 'text-zinc-200 active:bg-zinc-800'
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">{m.id}</span>
                      {isCurrent && (
                        <span className="flex-shrink-0 text-xs text-indigo-400">
                          当前
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </MobileSheet>
    </div>
  );
}
