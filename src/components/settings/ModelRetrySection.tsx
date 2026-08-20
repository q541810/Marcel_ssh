import { useMemo } from 'react';
import type { LlmConfig } from '@/lib/types';
import { Card, SettingItem } from './helpers';
import { useSettingsActions } from './SettingsActionsContext';
import { ValidatedInput } from './ValidatedInput';
import Toggle from '@/components/ui/Toggle';

export function validateRetryHttpStatuses(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null; // empty is valid (no HTTP retry)

  for (const entry of trimmed.split(',')) {
    const entryTrimmed = entry.trim();
    if (!entryTrimmed) continue;

    if (entryTrimmed.includes('-')) {
      const parts = entryTrimmed.split('-');
      if (parts.length !== 2) return `无效范围: "${entryTrimmed}"（使用格式 lo-hi）`;
      const lo = Number(parts[0].trim());
      const hi = Number(parts[1].trim());
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return `无法解析范围: "${entryTrimmed}"`;
      if (lo < 100 || lo > 599 || hi < 100 || hi > 599) return `状态码超出范围 (100-599): "${entryTrimmed}"`;
      if (hi < lo) return `范围需从小到大: "${entryTrimmed}"`;
    } else {
      const code = Number(entryTrimmed);
      if (!Number.isFinite(code)) return `无效状态码: "${entryTrimmed}"`;
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
        firstByteTimeoutSecs: 60,
        retryOnTimeout: true,
      },
    [settings.llmConfig]
  );

  const updateLlm = (patch: Partial<LlmConfig>) => {
    update({ llmConfig: { ...llmConfig, ...patch } });
  };

  return (
    <Card id="settings-llm-retry" title="请求重试" description="LLM API 调用失败时自动重试，规避供应商偶发异常">
      <SettingItem id="llm-max-retries" label="最大重试次数" description="LLM 请求失败时自动重试的最大次数（0 = 不重试）" sectionId="settings-llm-retry" keywords={['retry', '重试', '请求重试']}>
        <ValidatedInput
          type="number"
          value={llmConfig.maxRetries}
          onChange={(v) => updateLlm({ maxRetries: v })}
          validate={(s) => {
            const v = Number(s);
            if (!Number.isInteger(v) || v < 0 || v > 10) return '须为 0-10 的整数';
            return null;
          }}
          validatorId="maxRetries"
          validatorFn={(draft) => {
            const v = draft.llmConfig?.maxRetries;
            if (v === undefined) return null;
            if (!Number.isInteger(v) || v < 0 || v > 10) return `最大重试次数须为 0-10 的整数（当前值：${v}）`;
            return null;
          }}
          min={0} max={10} step={1}
          suffix="次"
          className="w-24"
        />
      </SettingItem>
      <SettingItem id="llm-retry-delay" label="重试间隔 (秒)" description="两次重试之间的等待时间" sectionId="settings-llm-retry" keywords={['delay', '间隔', '重试']}>
        <ValidatedInput
          type="number"
          value={llmConfig.retryDelaySecs}
          onChange={(v) => updateLlm({ retryDelaySecs: v })}
          validate={(s) => {
            const v = Number(s);
            if (!Number.isFinite(v) || v < 1 || v > 60) return '须为 1-60 的有限数字';
            return null;
          }}
          validatorId="retryDelaySecs"
          validatorFn={(draft) => {
            const v = draft.llmConfig?.retryDelaySecs;
            if (v === undefined) return null;
            if (!Number.isFinite(v) || v < 1 || v > 60) return `重试间隔须为 1-60 的有限数字（当前值：${v}）`;
            return null;
          }}
          min={1} max={60} step={1}
          suffix="秒"
          className="w-24"
        />
      </SettingItem>
      <SettingItem id="llm-retry-statuses" label="重试条件" description="逗号分隔的 HTTP 状态码或范围（如 408, 429, 500-599）。匹配到对应状态码时触发重试。" sectionId="settings-llm-retry" keywords={['retry', '重试条件', '状态码']}>
        <ValidatedInput
          type="text"
          value={llmConfig.retryHttpStatuses}
          onChange={(v) => updateLlm({ retryHttpStatuses: v })}
          validate={validateRetryHttpStatuses}
          validatorId="retryHttpStatuses"
          validatorFn={(draft) => validateRetryHttpStatuses(draft.llmConfig?.retryHttpStatuses ?? '')}
          placeholder="408, 429, 500-599"
          className="w-full"
        />
      </SettingItem>
      <SettingItem id="llm-first-byte-timeout" label="首字超时 (秒)" description="从请求发出到收到首个字符的最长等待，超时视为失败并按重试策略处理" sectionId="settings-llm-retry" keywords={['timeout', '首字超时', '首包', '超时']}>
        <ValidatedInput
          type="number"
          value={llmConfig.firstByteTimeoutSecs ?? 60}
          onChange={(v) => updateLlm({ firstByteTimeoutSecs: v })}
          validate={(s) => {
            const v = Number(s);
            if (!Number.isInteger(v) || v < 20 || v > 250) return '须为 20-250 的整数';
            return null;
          }}
          validatorId="firstByteTimeoutSecs"
          validatorFn={(draft) => {
            const v = draft.llmConfig?.firstByteTimeoutSecs;
            if (v === undefined) return null;
            if (!Number.isInteger(v) || v < 20 || v > 250) return `首字超时须为 20-250 的整数（当前值：${v}）`;
            return null;
          }}
          min={20} max={250} step={5}
          suffix="秒"
          className="w-24"
        />
      </SettingItem>
      <SettingItem id="llm-retry-on-timeout" label="超时自动重试" description="首字超时后是否自动重试（默认开启，复用上方重试次数与间隔）" sectionId="settings-llm-retry" keywords={['timeout', '重试', '超时重试']}>
        <Toggle checked={llmConfig.retryOnTimeout ?? true} onChange={(v) => updateLlm({ retryOnTimeout: v })} />
      </SettingItem>
    </Card>
  );
}
