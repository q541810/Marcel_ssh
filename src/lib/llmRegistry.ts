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
  return { modelApprovalModelId: '', summarizerModelId: '' };
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

/**
 * 当前会话/全局生效的主模型：
 * `sessionModelId`（会话级内存记忆，可选）> 全局最近使用 lastUsedModelId > 第一个模型。
 * 与后端解析优先级一致：会话记忆 → last_used → 首个可用。
 */
export function effectiveModel(
  r: LlmRegistry,
  sessionModelId?: string | null,
): ModelEntry | undefined {
  if (sessionModelId) {
    const m = findModel(r, sessionModelId);
    if (m) return m;
  }
  return effectiveDefaultModel(r);
}

/** 有效主模型 ID（会话记忆 → lastUsed → 首个；无模型 = ''）。 */
export function effectiveModelId(
  r: LlmRegistry,
  sessionModelId?: string | null,
): string {
  return effectiveModel(r, sessionModelId)?.id ?? '';
}

/**
 * 全局兜底主模型：全局最近使用（lastUsedModelId）优先；为空/失效回落
 * 第一个模型（与后端 default_model 一致）。只依赖全局设置，不感知会话。
 */
export function effectiveDefaultModel(r: LlmRegistry): ModelEntry | undefined {
  if (r.lastUsedModelId) {
    const m = findModel(r, r.lastUsedModelId);
    if (m) return m;
  }
  return r.models[0];
}

/** 有效默认模型 ID（lastUsed 为空时 = 第一个模型的 id；无模型 = ''）。 */
export function effectiveDefaultModelId(r: LlmRegistry): string {
  return effectiveDefaultModel(r)?.id ?? '';
}

/** 当前主模型是否支持图片输入（AgentPanel / taskStore 的 vision 来源）。 */
export function currentVision(r: LlmRegistry, sessionModelId?: string | null): boolean {
  return effectiveModel(r, sessionModelId)?.vision ?? false;
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
    reasoningEfforts: [],
  };
}

/** 模型声明的可用思考强度档位（归一化去重；空 = 未启用）。 */
export function modelReasoningEfforts(model: ModelEntry | undefined): string[] {
  if (!model) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of model.reasoningEfforts ?? []) {
    const t = e.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** 会话当前生效模型的思考档位是否可用（即模型声明了且含该档位）。 */
export function effortValidForModel(
  model: ModelEntry | undefined,
  effort: string | null | undefined,
): boolean {
  if (!effort) return false;
  return modelReasoningEfforts(model).includes(effort);
}

/**
 * 按 id 去重模型条目（保留每个 id 的「最后一次出现」并维持原有相对顺序）。
 *
 * 语义说明：历史「保存渠道」合并逻辑（已修复，见 mergeChannelModels）曾把
 * 该渠道仍保留在草稿里的旧模型原样保留、又整体追加草稿，产生同 id 重复
 * 条目。重复中靠后的条目通常是草稿中较新的编辑版本（编辑 = 保留原 id 的
 * 新对象），因此去重保留最后出现者，避免丢掉用户最近的编辑。
 * 无 id 的条目不丢弃（保持原样，交由后端校验拦截）。
 */
export function dedupeModelEntries(models: ModelEntry[]): ModelEntry[] {
  const lastSeen = new Map<string, number>();
  models.forEach((m, i) => {
    if (m && m.id) lastSeen.set(m.id, i);
  });
  return models.filter((m, i) => !m || !m.id || lastSeen.get(m.id) === i);
}

/**
 * 保存渠道后合并模型列表（桌面端 / 移动端共用，替代两处重复的手写合并）。
 *
 * 规则：
 * - 该渠道的模型**整体替换**为草稿（旧列表里被删掉的模型不再保留）；
 * - 其它渠道的模型原样保留，相对顺序不变；
 * - 合并结果按 id 去重（保留最后出现者，防御旧损坏数据/草稿自带重复）；
 * - 清理指向被删除模型的槽位引用与全局最近使用；
 * - 新建渠道且尚无最近使用模型时，把草稿第一个模型设为最近使用（与旧行为一致）。
 *
 * 修复背景：旧实现 `otherModels` 用 `keptModelIds.has(m.id)` 把本渠道仍在
 * 草稿中的旧模型也保留，随后又整体追加草稿 → 每次保存渠道都会把该渠道
 * 每个保留模型复制成同 id 两条（表现为模型选择器里同一模型出现两次）。
 */
export function mergeChannelModels(
  r: LlmRegistry,
  channel: ChannelConfig,
  draftModels: ModelEntry[],
): LlmRegistry {
  const isNew = !r.channels.some((c) => c.id === channel.id);
  const channels = isNew
    ? [...r.channels, channel]
    : r.channels.map((c) => (c.id === channel.id ? channel : c));

  // 本渠道模型整体替换为草稿；其余渠道原样保留；同 id 只留最后一条。
  const merged = [
    ...r.models.filter((m) => m.channelId !== channel.id),
    ...draftModels,
  ];
  const models = dedupeModelEntries(merged);

  // 槽位清理：被删除的模型若被槽位引用则清空
  const slotTargets = new Set(models.map((m) => m.id));
  const slots = { ...r.slots };
  if (!slotTargets.has(slots.modelApprovalModelId)) slots.modelApprovalModelId = '';
  if (!slotTargets.has(slots.summarizerModelId)) slots.summarizerModelId = '';

  // 最近使用清理：被删模型若是全局最近使用则清空（解析回落第一个模型）
  let lastUsedModelId =
    r.lastUsedModelId && !slotTargets.has(r.lastUsedModelId)
      ? ''
      : r.lastUsedModelId;
  // 新建第一个渠道且尚无全局最近使用模型时，自动把第一个模型设为最近使用
  if (isNew && !lastUsedModelId && draftModels[0]) {
    lastUsedModelId = draftModels[0].id;
  }

  return { ...r, channels, models, slots, lastUsedModelId };
}

/** 删除渠道：级联删除其模型，并清理指向被删模型的槽位与最近使用。返回新 registry。 */
export function removeChannel(r: LlmRegistry, channelId: string): LlmRegistry {
  const removedModelIds = new Set(
    r.models.filter((m) => m.channelId === channelId).map((m) => m.id),
  );
  return clearModelReferences(
    {
      ...r,
      channels: r.channels.filter((c) => c.id !== channelId),
      models: r.models.filter((m) => m.channelId !== channelId),
    },
    removedModelIds,
  );
}

/** 删除单个模型：清理指向它的槽位与最近使用。返回新 registry。 */
export function removeModel(r: LlmRegistry, modelId: string): LlmRegistry {
  return clearModelReferences(
    {
      ...r,
      models: r.models.filter((m) => m.id !== modelId),
    },
    new Set([modelId]),
  );
}

function clearSlotsForRemoved(slots: ModelSlots, removedIds: Set<string>): ModelSlots {
  const next = { ...slots };
  if (removedIds.has(next.modelApprovalModelId)) next.modelApprovalModelId = '';
  if (removedIds.has(next.summarizerModelId)) next.summarizerModelId = '';
  return next;
}

/** 删除模型后清理 registry 顶层引用（lastUsed + 槽位）。返回新 registry。 */
export function clearModelReferences(
  r: LlmRegistry,
  removedIds: Set<string>,
): LlmRegistry {
  return {
    ...r,
    lastUsedModelId:
      r.lastUsedModelId && removedIds.has(r.lastUsedModelId) ? '' : r.lastUsedModelId,
    slots: clearSlotsForRemoved(r.slots, removedIds),
  };
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
