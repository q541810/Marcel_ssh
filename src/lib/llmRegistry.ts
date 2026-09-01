// 多渠道多模型注册表 —— 前端共享辅助（桌面端 / 移动端共用）。
//
// 职责：把 AppSettings.llmRegistry（渠道 / 模型 / 槽位）上的纯函数操作收敛到
// 一处，避免桌面与移动端各自实现一套「找默认模型」「级联删除」「生成 ID」等
// 逻辑。所有函数都是不可变的（返回新对象），配合 settingsStore.update 使用。

import type {
  ChannelConfig,
  LlmRegistry,
  ModelEntry,
  ModelSlots,
  NetPolicy,
} from '@/lib/types';

/** 生成稳定唯一 ID（uuid v4）。 */
export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // 兜底（非安全上下文等场景）
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/** 默认全局网络与重试策略（与后端 NetPolicy serde default 对齐）。 */
export function defaultNetPolicy(): NetPolicy {
  return {
    maxRetries: 1,
    retryDelaySecs: 5,
    retryHttpStatuses: '408, 429, 500-599',
    firstByteTimeoutSecs: 60,
    retryOnTimeout: true,
  };
}

export function emptyRegistry(): LlmRegistry {
  return { channels: [], models: [], slots: emptySlots(), netPolicy: defaultNetPolicy() };
}

export function emptySlots(): ModelSlots {
  return { defaultModelId: '', modelApprovalModelId: '', summarizerModelId: '' };
}

export function findChannel(r: LlmRegistry, channelId: string): ChannelConfig | undefined {
  return r.channels.find((c) => c.id === channelId);
}

export function findModel(r: LlmRegistry, modelId: string): ModelEntry | undefined {
  return r.models.find((m) => m.id === modelId);
}

/** 模型展示标签：displayName 优先，否则 modelName。 */
export function modelLabel(model: ModelEntry | undefined): string {
  if (!model) return '';
  return (model.displayName ?? '').trim() !== '' ? model.displayName!.trim() : model.modelName;
}

/** 槽位选择器用的完整标签：`展示名 · 渠道名`。 */
export function modelFullLabel(r: LlmRegistry, modelId: string): string {
  const m = findModel(r, modelId);
  if (!m) return '';
  const label = modelLabel(m);
  const ch = findChannel(r, m.channelId);
  return ch ? `${label} · ${ch.name}` : label;
}

/**
 * 当前模型名是否在其它渠道存在同名模型。
 *
 * 用于输入框触发器消歧：跨渠道同名时（如「DeepSeek 官方」与「硅基流动」
 * 都有 deepseek-chat），只显示模型名会无法区分，需要带渠道名前缀。
 */
export function modelNameDuplicatedInOtherChannels(
  r: LlmRegistry,
  model: ModelEntry | undefined,
): boolean {
  if (!model) return false;
  const name = model.modelName.trim();
  if (!name) return false;
  return r.models.some(
    (m) =>
      m.id !== model.id &&
      m.modelName.trim() === name &&
      m.channelId !== model.channelId,
  );
}

/**
 * 输入框触发器的模型标签：仅当模型名在其它渠道也有同名时才显示
 * `渠道名/模型名` 消歧；否则只显示模型名（窄空间不重复供应商名）。
 */
export function modelPickerTriggerLabel(
  r: LlmRegistry,
  model: ModelEntry | undefined,
): string {
  if (!model) return '';
  if (modelNameDuplicatedInOtherChannels(r, model)) {
    const ch = findChannel(r, model.channelId);
    return ch ? `${ch.name}/${modelLabel(model)}` : modelLabel(model);
  }
  return modelLabel(model);
}

export function modelsOfChannel(r: LlmRegistry, channelId: string): ModelEntry[] {
  return r.models.filter((m) => m.channelId === channelId);
}

/** 有效默认模型：槽位优先；槽位为空/失效回落第一个模型（与后端一致）。 */
export function effectiveDefaultModel(r: LlmRegistry): ModelEntry | undefined {
  if (r.slots.defaultModelId) {
    const m = findModel(r, r.slots.defaultModelId);
    if (m) return m;
  }
  return r.models[0];
}

/** 有效默认模型 ID（槽位为空时 = 第一个模型的 id；无模型 = ''）。 */
export function effectiveDefaultModelId(r: LlmRegistry): string {
  return effectiveDefaultModel(r)?.id ?? '';
}

/** 当前默认模型是否支持图片输入（AgentPanel / taskStore 的 vision 来源）。 */
export function currentVision(r: LlmRegistry): boolean {
  return effectiveDefaultModel(r)?.vision ?? false;
}

/** 新建一个渠道（生成 ID，默认启用）。网络策略走全局，渠道不再持有。 */
export function createChannel(name: string, baseUrl: string): ChannelConfig {
  return {
    id: newId(),
    name,
    baseUrl,
    apiKey: '',
    enabled: true,
  };
}

/** 新建一个模型条目（归属指定渠道）。 */
export function createModel(channelId: string, modelName: string): ModelEntry {
  return {
    id: newId(),
    channelId,
    modelName,
    displayName: '',
    temperature: 0.1,
    vision: false,
    contextWindow: 0,
    extraBody: null,
  };
}

/** 删除渠道：级联删除其模型，并清理指向被删模型的槽位。返回新 registry。 */
export function removeChannel(r: LlmRegistry, channelId: string): LlmRegistry {
  const removedModelIds = new Set(
    r.models.filter((m) => m.channelId === channelId).map((m) => m.id),
  );
  return {
    channels: r.channels.filter((c) => c.id !== channelId),
    models: r.models.filter((m) => m.channelId !== channelId),
    slots: clearSlotsForRemoved(r.slots, removedModelIds),
    netPolicy: r.netPolicy,
  };
}

/** 删除单个模型：清理指向它的槽位。返回新 registry。 */
export function removeModel(r: LlmRegistry, modelId: string): LlmRegistry {
  return {
    channels: r.channels,
    models: r.models.filter((m) => m.id !== modelId),
    slots: clearSlotsForRemoved(r.slots, new Set([modelId])),
    netPolicy: r.netPolicy,
  };
}

function clearSlotsForRemoved(slots: ModelSlots, removedIds: Set<string>): ModelSlots {
  const next = { ...slots };
  if (removedIds.has(next.defaultModelId)) next.defaultModelId = '';
  if (removedIds.has(next.modelApprovalModelId)) next.modelApprovalModelId = '';
  if (removedIds.has(next.summarizerModelId)) next.summarizerModelId = '';
  return next;
}

/** 设置槽位后自动清理失效引用（防悬挂）。返回新 registry。 */
export function setSlot(r: LlmRegistry, key: keyof ModelSlots, modelId: string): LlmRegistry {
  const slots = { ...r.slots, [key]: modelId };
  return { ...r, slots };
}

/**
 * 按渠道（提供商）分组的模型选择项，供模型选择列表/下拉使用。
 *
 * 结构：`[{ label: 渠道名, options: [{ value: 模型id, label: 模型展示名 }] }]`。
 * 只包含启用渠道（禁用渠道的模型不可选，避免选到解析会失败的模型）。
 * 渠道内保持注册顺序；无模型的渠道不出现。
 */
export function modelOptionsByChannel(r: LlmRegistry): {
  label: string;
  options: { value: string; label: string }[];
}[] {
  return r.channels
    .filter((c) => c.enabled)
    .map((c) => ({
      label: c.name,
      options: modelsOfChannel(r, c.id).map((m) => ({
        value: m.id,
        label: modelLabel(m),
      })),
    }))
    .filter((g) => g.options.length > 0);
}

/** 校验渠道名是否重复（排除自身）。返回重复的渠道名或 null。 */
export function duplicateChannelName(
  r: LlmRegistry,
  name: string,
  excludeId?: string,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const hit = r.channels.find((c) => c.name.trim() === trimmed && c.id !== excludeId);
  return hit ? hit.name : null;
}

/** 校验渠道下模型名是否重复（排除自身）。返回重复的模型名或 null。 */
export function duplicateModelName(
  r: LlmRegistry,
  channelId: string,
  modelName: string,
  excludeId?: string,
): string | null {
  const trimmed = modelName.trim();
  if (!trimmed) return null;
  const hit = r.models.find(
    (m) => m.channelId === channelId && m.modelName.trim() === trimmed && m.id !== excludeId,
  );
  return hit ? hit.modelName : null;
}
