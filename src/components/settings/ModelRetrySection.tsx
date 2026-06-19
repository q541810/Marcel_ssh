import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { LlmConfig } from '@/lib/types';
import { Card, SettingItem } from './helpers';
import { useSettingsActions } from './SettingsActionsContext';

export function validateRetryHttpStatuses(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null; // empty is valid (no HTTP retry)

  for (const entry of value.split(',')) {
    const entryTrimmed = entry.trim();
    if (!entryTrimmed) continue;

    if (entryTrimmed.includes('-')) {
      const parts = entryTrimmed.split('-');
      if (parts.length !== 2) return `无效范围: "${entryTrimmed}"（使用格式 lo-hi）`;
      const lo = parseInt(parts[0], 10);
      const hi = parseInt(parts[1], 10);
      if (isNaN(lo) || isNaN(hi)) return `无法解析范围: "${entryTrimmed}"`;
      if (lo < 100 || lo > 599 || hi < 100 || hi > 599) return `状态码超出范围 (100-599): "${entryTrimmed}"`;
      if (hi < lo) return `范围需从小到大: "${entryTrimmed}"`;
    } else {
      const code = parseInt(entryTrimmed, 10);
      if (isNaN(code)) return `无效状态码: "${entryTrimmed}"`;
      if (code < 100 || code > 599) return `状态码超出范围 (100-599): "${entryTrimmed}"`;
    }
  }
  return null;
}

export function ModelRetrySection() {
  const { settings, update } = useSettingsActions();
  const llmConfig: LlmConfig = useMemo(
    () =>
      settings.llmConfig ?? {
        providerType: 'openai',
        apiKey: '',
        model: '',
        baseUrl: '',
        temperature: 0.1,
        maxRetries: 1,
        retryDelaySecs: 5,
        retryHttpStatuses: '408, 429, 500-599',
      },
    [settings.llmConfig]
  );

  const [statusesError, setStatusesError] = useState<string | null>(null);

  const updateLlm = useCallback((patch: Partial<LlmConfig>) => {
    update({ llmConfig: { ...llmConfig, ...patch } });
  }, [update, llmConfig]);

  const updateLlmRef = useRef(updateLlm);
  useEffect(() => {
    updateLlmRef.current = updateLlm;
  }, [updateLlm]);

  const handleStatusesChange = useCallback((value: string) => {
    const err = validateRetryHttpStatuses(value);
    setStatusesError(err);
    updateLlmRef.current({ retryHttpStatuses: value });
  }, []);

  const handleStatusesBlur = useCallback(() => {
    const err = validateRetryHttpStatuses(llmConfig.retryHttpStatuses);
    setStatusesError(err);
  }, [llmConfig.retryHttpStatuses]);

  return (
    <Card id="settings-llm-retry" title="请求重试" description="LLM API 调用失败时自动重试，规避供应商偶发异常">
      <SettingItem id="llm-max-retries" label="最大重试次数" description="LLM 请求失败时自动重试的最大次数（0 = 不重试）" sectionId="settings-llm-retry" keywords={['retry', '重试', '请求重试']}>
        <input
          type="number"
          min={0}
          max={10}
          step={1}
          value={llmConfig.maxRetries}
          onChange={(e) => updateLlm({ maxRetries: Math.max(0, Math.min(10, parseInt(e.target.value) || 0)) })}
          className="w-24 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
        />
      </SettingItem>
      <SettingItem id="llm-retry-delay" label="重试间隔 (秒)" description="两次重试之间的等待时间" sectionId="settings-llm-retry" keywords={['delay', '间隔', '重试']}>
        <input
          type="number"
          min={1}
          max={60}
          step={1}
          value={llmConfig.retryDelaySecs}
          onChange={(e) => updateLlm({ retryDelaySecs: Math.max(1, Math.min(60, parseFloat(e.target.value) || 5)) })}
          className="w-24 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
        />
      </SettingItem>
      <SettingItem id="llm-retry-statuses" label="重试条件" description="逗号分隔的 HTTP 状态码或范围（如 408, 429, 500-599）。匹配到对应状态码时触发重试；网络/超时错误始终重试。" sectionId="settings-llm-retry" keywords={['retry', '重试条件', '状态码']}>
        <div className="flex-1">
          <input
            type="text"
            value={llmConfig.retryHttpStatuses}
            onChange={(e) => handleStatusesChange(e.target.value)}
            onBlur={handleStatusesBlur}
            placeholder="408, 429, 500-599"
            className={`w-full rounded-lg px-3 py-1.5 text-sm font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500 ${
              statusesError
                ? 'bg-red-900/20 border border-red-500/50 focus:border-red-400'
                : 'bg-zinc-800 border border-zinc-700'
            }`}
          />
          {statusesError && (
            <p className="text-xs text-red-400 mt-1">{statusesError}</p>
          )}
        </div>
      </SettingItem>
    </Card>
  );
}
