import { useState, useMemo } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import type { AgentModeSettings, ChannelConfig, LlmRegistry, ModelEntry, ModelSlots, NetPolicy } from '@/lib/types';
import Select, { type SelectGroup } from '@/components/ui/Select';
import Button from '@/components/ui/Button';
import Toggle from '@/components/ui/Toggle';
import { Card, SettingItem } from './helpers';
import { ValidatedInput } from './ValidatedInput';
import { useSettingsActions } from './SettingsActionsContext';
import { contextWindowHint } from '@/lib/contextWindowHints';
import ChannelEditModal from './ChannelEditModal';
import { validateRetryHttpStatuses } from '@/lib/llmParams';
import {
  modelsOfChannel,
  removeChannel,
  modelOptionsByChannel,
  mergeChannelModels,
} from '@/lib/llmRegistry';

/** 从注册表生成槽位选择器的选项（按渠道分组）。 */
function modelOptions(registry: LlmRegistry): SelectGroup[] {
  return modelOptionsByChannel(registry);
}

export function ModelServiceSection() {
  const { settings, update } = useSettingsActions();
  const channelKeyStatus = useSettingsStore((s) => s.channelKeyStatus);

  const registry: LlmRegistry = settings.llmRegistry ?? {
    channels: [],
    models: [],
    slots: { modelApprovalModelId: '', summarizerModelId: '' },
    netPolicy: {
      maxRetries: 1,
      retryDelaySecs: 5,
      retryHttpStatuses: '408, 429, 500-599',
      firstByteTimeoutSecs: 60,
      retryOnTimeout: true,
    },
  };
  const slots: ModelSlots = registry.slots;
  const netPolicy: NetPolicy = registry.netPolicy;

  const [channelEditor, setChannelEditor] = useState<{
    open: boolean;
    channel?: ChannelConfig;
  }>({ open: false });

  const updateRegistry = (next: LlmRegistry) => {
    update({ llmRegistry: next });
  };

  const updateSlots = (patch: Partial<ModelSlots>) => {
    updateRegistry({ ...registry, slots: { ...slots, ...patch } });
  };

  const updateNetPolicy = (patch: Partial<NetPolicy>) => {
    updateRegistry({ ...registry, netPolicy: { ...netPolicy, ...patch } });
  };

  const options = useMemo(() => modelOptions(registry), [registry]);
  // 辅助槽位 Select 需要「跟随会话模型/无」选项
  const slotOptions = useMemo(
    () => [
      { value: '', label: '跟随会话使用的模型' },
      ...options,
    ],
    [options],
  );

  const handleChannelSave = (channel: ChannelConfig, channelModels: ModelEntry[]) => {
    // 本渠道模型整体替换为草稿 + 按 id 去重 + 槽位/最近使用清理（桌面/移动端共用）
    updateRegistry(mergeChannelModels(registry, channel, channelModels));
  };

  const handleDeleteChannel = (channel: ChannelConfig) => {
    updateRegistry(removeChannel(registry, channel.id));
  };

  return (
    <Card id="settings-llm" title="模型服务" description="管理多渠道接入与模型，并绑定审核 / 摘要等辅助场景模型">
      <SettingItem
        id="llm-summarizer-model"
        label="上下文压缩模型"
        description="压缩历史上下文时的摘要模型。留空 = 跟随会话正在使用的模型（运行中的 Agent 用什么，压缩就用什么）"
        sectionId="settings-llm"
        keywords={['summarizer', '摘要', '压缩', 'compaction', '模型']}
      >
        <Select
          value={slots.summarizerModelId}
          onChange={(v) => updateSlots({ summarizerModelId: v })}
          options={slotOptions}
          placeholder="跟随会话模型"
          className="w-72"
        />
      </SettingItem>

      <SettingItem id="llm-context-window" label="模型上下文窗口 (tokens)" description="留空或 0 = 仅在模型报告上下文超限时压缩旧历史；填写后按窗口的 80% 阈值预防式压缩。模型可单独设置，优先于这里的全局值" sectionId="settings-llm" keywords={['context', '上下文', 'token', '窗口', 'window', '压缩', 'compaction']}>
        <ValidatedInput
          type="number"
          value={settings.agentModeSettings?.contextWindow ?? 0}
          onChange={(v) => update({ agentModeSettings: { ...(settings.agentModeSettings ?? {}), contextWindow: v } as AgentModeSettings })}
          validate={(s) => {
            const v = Number(s);
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

      {/* ── 网络与重试策略（全局共享，所有渠道与模型统一生效） ── */}
      <SettingItem
        id="llm-net-policy"
        label="网络与重试策略"
        description="全局共享，所有渠道与模型统一生效（重试次数、间隔、状态码条件、首字超时、超时自动重试）"
        sectionId="settings-llm"
        keywords={['retry', '重试', '网络', 'timeout', '超时', '网络策略']}
      >
        <div className="flex-1 min-w-0 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <span className="text-xs text-zinc-400 flex-shrink-0">最大重试次数</span>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={10}
                step={1}
                value={netPolicy.maxRetries}
                onChange={(e) => updateNetPolicy({ maxRetries: Number(e.target.value) })}
                className="w-40 h-2 cursor-pointer appearance-none rounded-full bg-zinc-700 accent-indigo-500"
              />
              <span className="w-12 text-right font-mono text-sm text-indigo-300">
                {netPolicy.maxRetries} 次
              </span>
            </div>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-xs text-zinc-400 flex-shrink-0">重试间隔</span>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={1}
                max={60}
                step={1}
                value={netPolicy.retryDelaySecs}
                onChange={(e) => updateNetPolicy({ retryDelaySecs: Number(e.target.value) })}
                className="w-40 h-2 cursor-pointer appearance-none rounded-full bg-zinc-700 accent-indigo-500"
              />
              <span className="w-12 text-right font-mono text-sm text-indigo-300">
                {netPolicy.retryDelaySecs}s
              </span>
            </div>
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1">重试条件（状态码/范围）</label>
            <ValidatedInput
              type="text"
              value={netPolicy.retryHttpStatuses}
              onChange={(v) => updateNetPolicy({ retryHttpStatuses: v })}
              validate={(s) => validateRetryHttpStatuses(s)}
              validatorId="netPolicyRetryStatuses"
              validatorFn={(draft) => {
                const v = draft.llmRegistry?.netPolicy?.retryHttpStatuses;
                if (v === undefined) return null;
                return validateRetryHttpStatuses(v);
              }}
              placeholder="408, 429, 500-599"
              className="w-72"
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-xs text-zinc-400 flex-shrink-0">首字超时（秒）</span>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={20}
                max={250}
                step={5}
                value={netPolicy.firstByteTimeoutSecs}
                onChange={(e) => updateNetPolicy({ firstByteTimeoutSecs: Number(e.target.value) })}
                className="w-40 h-2 cursor-pointer appearance-none rounded-full bg-zinc-700 accent-indigo-500"
              />
              <span className="w-12 text-right font-mono text-sm text-indigo-300">
                {netPolicy.firstByteTimeoutSecs}s
              </span>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-400">超时自动重试</span>
            <Toggle
              checked={netPolicy.retryOnTimeout}
              onChange={(v) => updateNetPolicy({ retryOnTimeout: v })}
              label=""
            />
          </div>
        </div>
      </SettingItem>

      {/* ── 渠道列表 ── */}
      <div className="px-6 py-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-sm font-medium text-zinc-200">渠道</div>
            <div className="text-xs text-zinc-500 mt-0.5">
              OpenAI 兼容接入点（OpenRouter / DeepSeek / 硅基流动 / Ollama / OpenAI 官方等）
            </div>
          </div>
          <Button size="sm" onClick={() => setChannelEditor({ open: true })}>
            + 添加渠道
          </Button>
        </div>

        {registry.channels.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 py-8 text-center">
            <p className="text-sm text-zinc-500">还没有渠道。点击「添加渠道」接入第一个模型服务。</p>
            <p className="text-xs text-zinc-600 mt-1">API Key 加密保存在系统密钥链，不会落盘。</p>
          </div>
        ) : (
          <ul className="divide-y divide-zinc-800 overflow-hidden rounded-xl border border-zinc-800">
            {registry.channels.map((ch) => {
              const models = modelsOfChannel(registry, ch.id);
              const hasKey = channelKeyStatus[ch.id] ?? !!ch.apiKey;
              return (
                <li key={ch.id} className="flex items-center gap-3 px-4 py-3 bg-zinc-900/40">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-zinc-200 truncate">{ch.name}</span>
                      {!ch.enabled && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-700 text-zinc-400">
                          已禁用
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-zinc-500 font-mono truncate mt-0.5">
                      {ch.baseUrl || <span className="text-amber-500/80">未填写 Base URL</span>}
                    </div>
                    <div className="text-[11px] text-zinc-600 mt-0.5">
                      {models.length} 个模型 · {hasKey ? '已配置密钥' : '未配置密钥'}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setChannelEditor({ open: true, channel: ch })}
                    className="px-2.5 py-1.5 rounded-lg text-xs text-zinc-300 bg-zinc-800 hover:bg-zinc-700 transition-colors flex-shrink-0"
                  >
                    编辑
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ChannelEditModal
        open={channelEditor.open}
        onClose={() => setChannelEditor({ open: false })}
        channel={channelEditor.channel}
        registry={registry}
        channelHasKey={channelEditor.channel ? (channelKeyStatus[channelEditor.channel.id] ?? false) : false}
        onSave={handleChannelSave}
        onDelete={handleDeleteChannel}
      />
    </Card>
  );
}
