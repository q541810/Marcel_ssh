import { useState, useMemo } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import type { AgentModeSettings, ChannelConfig, LlmRegistry, ModelEntry, ModelSlots, NetPolicy, SubagentModelChoice } from '@/lib/types';
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
  candidateRowModelLabel,
  emptyRegistry,
} from '@/lib/llmRegistry';

/** 从注册表生成槽位选择器的选项（按渠道分组）。 */
function modelOptions(registry: LlmRegistry): SelectGroup[] {
  return modelOptionsByChannel(registry);
}

export function ModelServiceSection() {
  const { settings, update } = useSettingsActions();
  const channelKeyStatus = useSettingsStore((s) => s.channelKeyStatus);

  // llmRegistry.ts 的权威 emptyRegistry（不再手抄第 4 份空注册表字面量）
  const registry: LlmRegistry = settings.llmRegistry ?? emptyRegistry();
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

  // ── 子agent 模型候选（主 agent 派发子agent 时的可选项） ──
  const subagentChoices: SubagentModelChoice[] = (registry.subagentModels ?? []).filter(
    (c) => c && typeof c.modelId === 'string',
  );

  const updateSubagentChoice = (index: number, patch: Partial<SubagentModelChoice>) => {
    updateRegistry({
      ...registry,
      subagentModels: subagentChoices.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    });
  };

  const addSubagentChoice = () => {
    // 新行预选第一个**未被其他行占用**的模型：不让同一模型出现在两条候选里
    // （后端保存时也只保留首条——重复根本不该在 UI 上发生）
    const occupied = new Set(subagentChoices.map((c) => c.modelId));
    const firstFree = options.flatMap((g) => g.options).find((o) => !occupied.has(o.value));
    updateRegistry({
      ...registry,
      subagentModels: [...subagentChoices, { modelId: firstFree?.value ?? '', description: '' }],
    });
  };

  const removeSubagentChoice = (index: number) => {
    updateRegistry({
      ...registry,
      subagentModels: subagentChoices.filter((_, i) => i !== index),
    });
  };

  // 「添加候选」还有没有意义：无可用模型 → 提示先加渠道；全部模型已被占用 →
  // 提示清单已满；两者之外才显示按钮。
  const availableForNew = (() => {
    const occupied = new Set(subagentChoices.map((c) => c.modelId));
    return options.flatMap((g) => g.options).filter((o) => !occupied.has(o.value));
  })();

  // 候选行可选项：启用渠道的全部模型，**排除已被其他行占用的**；当前行自己
  // 的 value 若指向禁用渠道/被占用（只可能来自手改配置），补一个禁用选项让
  // 它仍可辨识，而不是回落成 placeholder 看起来像没选。
  const subagentRowOptions = (index: number, choice: SubagentModelChoice) => {
    const occupiedElsewhere = new Set(
      subagentChoices.filter((_, i) => i !== index).map((c) => c.modelId),
    );
    const groups = options
      .map((g) => ({
        ...g,
        options: g.options.filter((o) => !occupiedElsewhere.has(o.value)),
      }))
      .filter((g) => g.options.length > 0);
    if (!choice.modelId || groups.some((g) => g.options.some((o) => o.value === choice.modelId))) {
      return groups;
    }
    const label = candidateRowModelLabel(registry, choice.modelId, occupiedElsewhere);
    return [
      ...groups,
      {
        value: choice.modelId,
        label: label ?? '已失效的模型',
        disabled: true,
      },
    ];
  };

  const handleChannelSave = (channel: ChannelConfig, channelModels: ModelEntry[]) => {
    // 本渠道模型整体替换为草稿 + 按 id 去重 + 槽位/最近使用清理（桌面/移动端共用）
    updateRegistry(mergeChannelModels(registry, channel, channelModels));
  };

  // 「添加候选」三态的判定基底：有启用渠道下的可用模型，才有资格谈占用/满员。
  const hasEnabledChannelModels = registry.channels.some(
    (ch) => ch.enabled && modelsOfChannel(registry, ch.id).length > 0,
  );

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

      <SettingItem
        id="llm-subagent-models"
        label="子agent 模型候选"
        description="主 agent 派发子agent 时可从这份清单按任务难度自选模型，每条写一句适用场景作为选型提示。未配置时，子agent 恒使用当前会话的模型"
        sectionId="settings-llm"
        keywords={['subagent', '子agent', '子代理', '候选', '派发', '选型', '模型']}
      >
        <div className="flex-1 min-w-0 space-y-2">
          {subagentChoices.length === 0 ? (
            <p className="text-xs text-zinc-500">
              清单为空：子agent 跟随当前会话的模型。添加候选后，主 agent 会按描述自行选型。
            </p>
          ) : (
            subagentChoices.map((choice, i) => (
              <div key={i} className="flex items-center gap-2">
                <Select
                  value={choice.modelId}
                  onChange={(v) => updateSubagentChoice(i, { modelId: v })}
                  options={subagentRowOptions(i, choice)}
                  placeholder="选择模型"
                  className="w-56 flex-shrink-0"
                />
                <input
                  type="text"
                  value={choice.description}
                  onChange={(e) => updateSubagentChoice(i, { description: e.target.value })}
                  placeholder="选型提示，如：小模型，适合搜索等简单任务"
                  className="flex-1 min-w-0 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500 transition-colors"
                />
                <button
                  type="button"
                  onClick={() => removeSubagentChoice(i)}
                  className="px-2.5 py-1.5 rounded-lg text-xs text-zinc-300 bg-zinc-800 hover:bg-zinc-700 transition-colors flex-shrink-0"
                  title="移除该候选"
                >
                  移除
                </button>
              </div>
            ))
          )}
          {hasEnabledChannelModels ? (
            availableForNew.length > 0 ? (
              <Button size="sm" onClick={addSubagentChoice}>
                + 添加候选
              </Button>
            ) : (
              <p className="text-xs text-zinc-600">全部可用模型都已在清单里。</p>
            )
          ) : registry.models.length > 0 ? (
            <p className="text-xs text-zinc-600">所有渠道均已禁用，启用后才能配置候选。</p>
          ) : (
            <p className="text-xs text-zinc-600">先在下方添加渠道与模型，才能配置候选。</p>
          )}
        </div>
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
