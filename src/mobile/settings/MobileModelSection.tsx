import { useState } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import type { AgentModeSettings, ChannelConfig, LlmRegistry, ModelEntry, ModelInfo, NetPolicy } from '@/lib/types';
import { llmListModels } from '@/lib/tauri';
import { getErrorMessage } from '@/lib/errors';
import Toggle from '@/components/ui/Toggle';
import { useSettingsActions } from '@/components/settings/SettingsActionsContext';
import { contextWindowHint } from '@/lib/contextWindowHints';
import { validateRetryHttpStatuses, validateExtraBodyJson, extraBodyToText, textToExtraBody } from '@/lib/llmParams';
import {
  modelsOfChannel,
  modelLabel,
  modelFullLabel,
  effectiveDefaultModel,
  createModel,
  removeChannel,
  duplicateChannelName,
  duplicateModelName,
  defaultNetPolicy,
} from '@/lib/llmRegistry';
import MobileSheet from '../ui/MobileSheet';
import { MobileSettingRow } from './MobileSettingRow';

const inputClass =
  'w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-indigo-500';

/** 空注册表兜底（settings 尚未初始化时）。 */
function emptyRegistry(): LlmRegistry {
  return {
    channels: [],
    models: [],
    slots: { defaultModelId: '', modelApprovalModelId: '', summarizerModelId: '' },
    netPolicy: defaultNetPolicy(),
  };
}

/** 模型选择底部弹层（默认模型 / 摘要模型槽位共用）。 */
function MobileModelPickerSheet({
  open,
  onClose,
  title,
  registry,
  value,
  allowEmpty,
  emptyLabel,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  registry: LlmRegistry;
  value: string;
  allowEmpty: boolean;
  emptyLabel: string;
  onChange: (modelId: string) => void;
}) {
  const models = registry.models;
  return (
    <MobileSheet open={open} onClose={onClose} title={title}>
      <div className="px-4 pb-4">
        {allowEmpty && (
          <button
            type="button"
            onClick={() => {
              onChange('');
              onClose();
            }}
            className="flex w-full items-center justify-between rounded-lg px-3 py-3 text-left text-sm active:bg-zinc-800"
          >
            <span className="text-zinc-200">{emptyLabel}</span>
            {!value && <span className="text-xs text-indigo-400">当前</span>}
          </button>
        )}
        {/* 按提供商（渠道）分组 */}
        {registry.channels.map((ch) => {
          const channelModels = modelsOfChannel(registry, ch.id);
          if (channelModels.length === 0) return null;
          const channelDisabled = !ch.enabled;
          return (
            <div key={ch.id} className="mt-1">
              <div className="flex items-center gap-2 px-3 pb-1 pt-2">
                <span className="truncate text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                  {ch.name}
                </span>
                {channelDisabled && (
                  <span className="flex-shrink-0 rounded bg-zinc-700 px-1 py-0.5 text-[10px] text-zinc-400">
                    已禁用
                  </span>
                )}
              </div>
              <div className="divide-y divide-zinc-800/70">
                {channelModels.map((m) => {
                  const selected = value === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      disabled={channelDisabled}
                      onClick={() => {
                        onChange(m.id);
                        onClose();
                      }}
                      className={`flex w-full items-center justify-between gap-2 px-3 py-3 text-left active:bg-zinc-800 ${
                        channelDisabled ? "opacity-40" : ""
                      }`}
                    >
                      <span className="min-w-0 truncate text-sm text-zinc-200">
                        {modelLabel(m)}
                      </span>
                      {selected && (
                        <span className="flex-shrink-0 text-xs text-indigo-400">当前</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
        {models.length === 0 && (
          <p className="py-6 text-center text-sm text-zinc-500">
            还没有模型，请先在「渠道」中添加
          </p>
        )}
      </div>
    </MobileSheet>
  );
}

/** 模型编辑底部弹层（新建 / 编辑共用）。父组件用 key 强制重挂载以重置表单。 */
function MobileModelEditorSheet({
  open,
  onClose,
  title,
  registry,
  channelId,
  initial,
  presetModelName,
  onSaved,
  onDeleted,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  registry: LlmRegistry;
  channelId: string;
  initial?: ModelEntry;
  presetModelName?: string;
  onSaved: (model: ModelEntry) => void;
  onDeleted: (modelId: string) => void;
}) {
  const [modelName, setModelName] = useState(initial?.modelName ?? presetModelName ?? '');
  const [displayName, setDisplayName] = useState(initial?.displayName ?? '');
  const [vision, setVision] = useState(initial?.vision ?? false);
  const [contextWindow, setContextWindow] = useState(initial?.contextWindow ?? 0);
  const [extraBodyText, setExtraBodyText] = useState(extraBodyToText(initial?.extraBody));
  // 「更多」折叠区：高级参数默认收起；编辑已有模型且已有自定义参数时默认展开
  const [moreOpen, setMoreOpen] = useState(
    extraBodyToText(initial?.extraBody).trim() !== '',
  );
  const [error, setError] = useState<string | null>(null);

  const handleSave = () => {
    const trimmed = modelName.trim();
    if (!trimmed) {
      setError('模型名称不能为空');
      return;
    }
    const dup = duplicateModelName(registry, channelId, trimmed, initial?.id);
    if (dup) {
      setError(`该渠道下模型「${dup}」已存在`);
      return;
    }
    const bodyErr = validateExtraBodyJson(extraBodyText);
    if (bodyErr) {
      setError(`高级参数 JSON 不合法：${bodyErr}`);
      return;
    }
    const model: ModelEntry = initial
      ? {
          ...initial,
          modelName: trimmed,
          displayName: displayName.trim(),
          vision,
          contextWindow: Math.max(0, Math.trunc(contextWindow)),
          extraBody: textToExtraBody(extraBodyText),
        }
      : {
          ...createModel(channelId, trimmed),
          displayName: displayName.trim(),
          vision,
          contextWindow: Math.max(0, Math.trunc(contextWindow)),
          extraBody: textToExtraBody(extraBodyText),
        };
    onSaved(model);
    onClose();
  };

  return (
    <MobileSheet open={open} onClose={onClose} title={title}>
      <div className="space-y-3 px-4 pb-4">
        <div>
          <label className="mb-1 block text-xs text-zinc-400">API 模型名 *</label>
          <input
            type="text"
            value={modelName}
            onChange={(e) => {
              setModelName(e.target.value);
              setError(null);
            }}
            placeholder="deepseek-ai/DeepSeek-V3"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className={inputClass}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-zinc-400">展示名（可选）</label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="DeepSeek V3"
            className={inputClass}
          />
        </div>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-zinc-200">视觉 / 支持图片</div>
            <div className="text-[11px] text-zinc-500">模型支持多模态时开启</div>
          </div>
          <Toggle checked={vision} onChange={setVision} />
        </div>
        <div>
          <label className="mb-1 block text-xs text-zinc-400">
            模型上下文窗口 (tokens) <span className="text-zinc-600">（0 = 跟随全局）</span>
          </label>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            step={1000}
            value={contextWindow}
            onChange={(e) =>
              setContextWindow(Math.max(0, Math.trunc(Number(e.target.value) || 0)))
            }
            placeholder="0 = 仅超限后压缩"
            className={inputClass}
          />
        </div>
        {/* ── 更多：高级参数（默认收起） ── */}
        <div>
          <button
            type="button"
            onClick={() => setMoreOpen((o) => !o)}
            aria-expanded={moreOpen}
            className="flex w-full items-center gap-2 py-1 text-sm font-medium text-zinc-200 active:text-zinc-100"
          >
            <svg
              className={`h-3.5 w-3.5 flex-shrink-0 transition-transform ${moreOpen ? 'rotate-90' : ''}`}
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M6 4l4 4-4 4" />
            </svg>
            <span>更多</span>
            {extraBodyText.trim() !== '' && (
              <span className="text-[11px] font-normal text-zinc-500">
                已设置自定义请求参数
              </span>
            )}
          </button>
          {moreOpen && (
            <div className="mt-1 space-y-1">
              <label className="mb-1 block text-xs text-zinc-400">
                高级：自定义请求参数（可选）
              </label>
              <textarea
                value={extraBodyText}
                onChange={(e) => setExtraBodyText(e.target.value)}
                placeholder={`{\n  "thinking": { "type": "enabled" },\n  "top_p": 0.9\n}`}
                spellCheck={false}
                rows={4}
                className="w-full resize-y rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-xs text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-indigo-500"
              />
              <p className="text-[11px] text-zinc-500">
                以 JSON 对象形式追加到请求体（如 thinking、top_p）。执行前模型审批不会携带这些参数。
              </p>
            </div>
          )}
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <div className="flex gap-2 pt-1">
          {initial && (
            <button
              type="button"
              onClick={() => {
                onDeleted(initial.id);
                onClose();
              }}
              className="flex-shrink-0 rounded-lg bg-red-900/40 px-4 py-2.5 text-sm text-red-300 active:bg-red-900/60"
            >
              删除
            </button>
          )}
          <button
            type="button"
            onClick={handleSave}
            className="flex-1 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white active:bg-indigo-500"
          >
            保存
          </button>
        </div>
      </div>
    </MobileSheet>
  );
}

/** 渠道编辑底部弹层（新建 / 编辑共用，含模型管理）。 */
function MobileChannelEditorSheet({
  open,
  onClose,
  channel,
  registry,
  hasKey,
  onSaveChannel,
  onDeleteChannel,
}: {
  open: boolean;
  onClose: () => void;
  channel?: ChannelConfig;
  registry: LlmRegistry;
  hasKey: boolean;
  /** 保存渠道 + 该渠道的模型列表（本地草稿，一次性提交，避免孤儿模型）。 */
  onSaveChannel: (channel: ChannelConfig, models: ModelEntry[]) => void;
  onDeleteChannel: (channel: ChannelConfig) => void;
}) {
  const isNew = !channel;
  // 父组件用 key 强制重挂载，因此这里直接用 props 作为初始值
  const [draftChannelId] = useState(channel?.id ?? crypto.randomUUID());
  const [localModels, setLocalModels] = useState<ModelEntry[]>(
    channel ? modelsOfChannel(registry, channel.id) : [],
  );
  const [name, setName] = useState(channel?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(channel?.baseUrl ?? '');
  const [enabled, setEnabled] = useState(channel?.enabled ?? true);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [modelEditor, setModelEditor] = useState<{ open: boolean; initial?: ModelEntry; preset?: string }>({
    open: false,
  });
  const [fetchOpen, setFetchOpen] = useState(false);
  const [fetchLoading, setFetchLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetchedModels, setFetchedModels] = useState<ModelInfo[]>([]);
  const [fetchFilter, setFetchFilter] = useState('');

  const models = localModels;

  const handleSave = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('渠道名称不能为空');
      return;
    }
    const dup = duplicateChannelName(registry, trimmed, channel?.id);
    if (dup) {
      setError(`渠道名「${dup}」已存在`);
      return;
    }
    const trimmedUrl = baseUrl.trim();
    if (!trimmedUrl) {
      setError('Base URL 不能为空，请填写 OpenAI 兼容端点');
      return;
    }
    if (!/^https?:\/\//.test(trimmedUrl)) {
      setError('Base URL 须以 http:// 或 https:// 开头');
      return;
    }
    const next: ChannelConfig = {
      ...(channel ?? { id: draftChannelId, apiKey: '' }),
      name: trimmed,
      baseUrl: trimmedUrl,
      enabled,
    };
    if (apiKeyInput.trim()) next.apiKey = apiKeyInput.trim();
    onSaveChannel(next, localModels);
    onClose();
  };

  const fetchModels = async () => {
    setFetchLoading(true);
    setFetchError(null);
    try {
      const list = await llmListModels(
        channel?.id ?? draftChannelId,
        baseUrl.trim() || null,
        apiKeyInput.trim() || null,
      );
      list.sort((a, b) => a.id.localeCompare(b.id));
      setFetchedModels(list);
    } catch (err) {
      setFetchError(getErrorMessage(err));
    } finally {
      setFetchLoading(false);
    }
  };

  const filterText = fetchFilter.trim().toLowerCase();
  const filtered =
    filterText === ''
      ? fetchedModels
      : fetchedModels.filter((m) => m.id.toLowerCase().includes(filterText));

  const handleModelSaved = (model: ModelEntry) => {
    setLocalModels((prev) => {
      const exists = prev.some((m) => m.id === model.id);
      return exists ? prev.map((m) => (m.id === model.id ? model : m)) : [...prev, model];
    });
  };

  return (
    <MobileSheet open={open} onClose={onClose} title={isNew ? '添加渠道' : `编辑渠道`}>
      <div className="space-y-3 px-4 pb-4">
        <div>
          <label className="mb-1 block text-xs text-zinc-400">渠道名称 *</label>
          <input
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            placeholder="DeepSeek 官方 / 硅基流动 / Ollama 本地"
            className={inputClass}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-zinc-400">Base URL</label>
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.deepseek.com/v1（必填）"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className={inputClass}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-zinc-400">API Key</label>
          <input
            type="password"
            value={apiKeyInput || (hasKey && !apiKeyInput ? 'sk-******' : '')}
            onChange={(e) =>
              setApiKeyInput(e.target.value === 'sk-******' ? '' : e.target.value)
            }
            placeholder="输入 API Key（加密保存在本设备）"
            autoComplete="off"
            className={inputClass}
          />
          {hasKey && !apiKeyInput && (
            <p className="mt-1 text-[11px] text-zinc-500">已保存密钥（掩码显示），留空不修改</p>
          )}
        </div>

        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-zinc-200">启用渠道</div>
            <div className="text-[11px] text-zinc-500">禁用后该渠道所有模型不可用</div>
          </div>
          <Toggle checked={enabled} onChange={setEnabled} />
        </div>

        {/* 模型列表 */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-3 py-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-zinc-200">
              模型 <span className="text-zinc-500">（{models.length}）</span>
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setFetchOpen(true);
                  setFetchFilter('');
                  void fetchModels();
                }}
                className="rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-200 active:bg-zinc-700"
              >
                获取列表
              </button>
              <button
                type="button"
                onClick={() => setModelEditor({ open: true })}
                className="rounded-lg bg-indigo-600 px-3 py-2 text-xs text-white active:bg-indigo-500"
              >
                + 添加
              </button>
            </div>
          </div>
          {models.length === 0 ? (
            <p className="py-3 text-center text-xs text-zinc-500">
              还没有模型。可「获取列表」从供应商拉取，或手动添加。
            </p>
          ) : (
            <div className="divide-y divide-zinc-800">
              {models.map((m) => (
                <div key={m.id} className="flex items-center gap-2 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-zinc-200">
                      {modelLabel(m)}
                      {m.vision && (
                        <span className="ml-2 rounded bg-indigo-600/20 px-1.5 py-0.5 text-[10px] text-indigo-300">
                          视觉
                        </span>
                      )}
                    </div>
                    {m.displayName && m.displayName !== m.modelName && (
                      <div className="truncate font-mono text-[11px] text-zinc-500">{m.modelName}</div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setModelEditor({ open: true, initial: m })}
                    className="rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-300 active:bg-zinc-700"
                  >
                    编辑
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <div className="flex gap-2 pt-1">
          {!isNew && (
            <button
              type="button"
              onClick={() => {
                if (!confirmDelete) {
                  setConfirmDelete(true);
                  return;
                }
                if (channel) onDeleteChannel(channel);
                onClose();
              }}
              className="flex-shrink-0 rounded-lg bg-red-900/40 px-4 py-2.5 text-sm text-red-300 active:bg-red-900/60"
            >
              {confirmDelete ? '确认删除渠道？' : '删除渠道'}
            </button>
          )}
          <button
            type="button"
            onClick={handleSave}
            className="flex-1 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white active:bg-indigo-500"
          >
            保存渠道
          </button>
        </div>
      </div>

      {/* 模型编辑（key 强制重挂载，重置表单为 initial/preset） */}
      <MobileModelEditorSheet
        key={modelEditor.initial?.id ?? (modelEditor.open ? 'new' : 'closed')}
        open={modelEditor.open}
        onClose={() => setModelEditor({ open: false })}
        title={modelEditor.initial ? '编辑模型' : '添加模型'}
        registry={registry}
        channelId={draftChannelId}
        initial={modelEditor.initial}
        presetModelName={modelEditor.preset}
        onSaved={handleModelSaved}
        onDeleted={(modelId) => {
          setLocalModels((prev) => prev.filter((m) => m.id !== modelId));
        }}
      />

      {/* 从 /models 拉取选择 */}
      <MobileSheet open={fetchOpen} onClose={() => setFetchOpen(false)} title="获取模型列表">
        <div className="space-y-2 px-4 pb-4">
          <input
            type="text"
            value={fetchFilter}
            onChange={(e) => setFetchFilter(e.target.value)}
            placeholder="过滤模型 ID…"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className={inputClass}
          />
          {fetchLoading && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在从供应商获取…
            </div>
          )}
          {!fetchLoading && fetchError && (
            <div className="space-y-3 py-4">
              <p className="break-words text-sm text-red-400">{fetchError}</p>
              <button
                type="button"
                onClick={() => void fetchModels()}
                className="w-full rounded-lg bg-zinc-800 px-3 py-2.5 text-sm text-zinc-200 active:bg-zinc-700"
              >
                重试
              </button>
            </div>
          )}
          {!fetchLoading && !fetchError && filtered.length === 0 && (
            <p className="py-8 text-center text-sm text-zinc-500">
              {fetchedModels.length === 0 ? '供应商未返回任何模型' : '无匹配模型'}
            </p>
          )}
          {!fetchLoading && !fetchError && filtered.length > 0 && (
            <div className="divide-y divide-zinc-800 overflow-hidden rounded-xl border border-zinc-800">
              {filtered.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    setFetchOpen(false);
                    // 预填模型名进入新建模型表单
                    setModelEditor({ open: true, initial: undefined, preset: m.id });
                  }}
                  className="flex w-full items-center gap-2 px-3 py-3 text-left font-mono text-sm text-zinc-200 active:bg-zinc-800"
                >
                  <span className="min-w-0 flex-1 truncate">{m.id}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </MobileSheet>
    </MobileSheet>
  );
}

/** Touch-first 多渠道多模型设置（与桌面端完全对齐）。 */
export function MobileModelSection() {
  const { settings, update } = useSettingsActions();
  const channelKeyStatus = useSettingsStore((s) => s.channelKeyStatus);

  const registry: LlmRegistry = settings.llmRegistry ?? emptyRegistry();
  const slots = registry.slots;
  const netPolicy: NetPolicy = registry.netPolicy;
  const effectiveDefault = effectiveDefaultModel(registry);

  const [defaultPicker, setDefaultPicker] = useState(false);
  const [summarizerPicker, setSummarizerPicker] = useState(false);
  const [channelEditor, setChannelEditor] = useState<{ open: boolean; channel?: ChannelConfig }>({
    open: false,
  });

  const updateRegistry = (next: LlmRegistry) => update({ llmRegistry: next });

  const updateNetPolicy = (patch: Partial<NetPolicy>) => {
    updateRegistry({ ...registry, netPolicy: { ...netPolicy, ...patch } });
  };

  const handleChannelSave = (channel: ChannelConfig, channelModels: ModelEntry[]) => {
    const isNew = !registry.channels.some((c) => c.id === channel.id);
    const channels = isNew
      ? [...registry.channels, channel]
      : registry.channels.map((c) => (c.id === channel.id ? channel : c));

    // 合并该渠道的模型草稿：删除被移除的旧模型、替换/新增草稿中的模型
    const keptModelIds = new Set(channelModels.map((m) => m.id));
    const otherModels = registry.models.filter(
      (m) => m.channelId !== channel.id || keptModelIds.has(m.id),
    );
    const models = [...otherModels, ...channelModels];

    // 槽位清理：被删除的模型若被槽位引用则清空
    const slotTargets = new Set(models.map((m) => m.id));
    const slots = { ...registry.slots };
    if (!slotTargets.has(slots.defaultModelId)) slots.defaultModelId = '';
    if (!slotTargets.has(slots.modelApprovalModelId)) slots.modelApprovalModelId = '';
    if (!slotTargets.has(slots.summarizerModelId)) slots.summarizerModelId = '';

    // 新建第一个渠道且尚无默认模型时，自动把第一个模型设为默认
    if (isNew && !slots.defaultModelId && channelModels[0]) {
      slots.defaultModelId = channelModels[0].id;
    }

    updateRegistry({ ...registry, channels, models, slots });
  };

  return (
    <div className="flex flex-col gap-2">
      {/* ── 场景槽位 ── */}
      <MobileSettingRow
        label="默认模型"
        description="主对话使用的模型。未设置时自动使用第一个模型"
      >
        <button
          type="button"
          onClick={() => setDefaultPicker(true)}
          className="mt-2 flex w-full items-center justify-between gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-sm text-zinc-100 active:bg-zinc-700"
        >
          <span className="truncate">
            {effectiveDefault
              ? modelFullLabel(registry, effectiveDefault.id)
              : '尚未配置模型'}
          </span>
          <ChevronDown className="h-4 w-4 flex-shrink-0 text-zinc-500" />
        </button>
      </MobileSettingRow>

      <MobileSettingRow
        label="上下文压缩模型"
        description="压缩历史时的摘要模型。留空 = 跟随默认模型"
      >
        <button
          type="button"
          onClick={() => setSummarizerPicker(true)}
          className="mt-2 flex w-full items-center justify-between gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-sm text-zinc-100 active:bg-zinc-700"
        >
          <span className="truncate">
            {slots.summarizerModelId
              ? modelFullLabel(registry, slots.summarizerModelId)
              : '跟随默认模型'}
          </span>
          <ChevronDown className="h-4 w-4 flex-shrink-0 text-zinc-500" />
        </button>
      </MobileSettingRow>

      <MobileSettingRow
        label="模型上下文窗口 (tokens)"
        description="留空或 0 = 仅在模型报告上下文超限时压缩旧历史；填写后按窗口的 80% 阈值预防式压缩。模型可单独设置，优先于这里的全局值"
      >
        <div className="mt-2 w-full space-y-1">
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
            return hint ? <p className="text-xs leading-relaxed text-zinc-500">{hint}</p> : null;
          })()}
        </div>
      </MobileSettingRow>

      {/* ── 网络与重试策略（全局共享，所有渠道与模型统一生效） ── */}
      <MobileSettingRow
        label="网络与重试策略"
        description="全局共享，所有渠道与模型统一生效（重试次数、间隔、状态码条件、首字超时、超时自动重试）"
      >
        <div className="mt-2 w-full space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-400">最大重试次数</span>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={10}
                step={1}
                value={netPolicy.maxRetries}
                onChange={(e) => updateNetPolicy({ maxRetries: Number(e.target.value) })}
                className="h-2 w-28 cursor-pointer appearance-none rounded-full bg-zinc-700 accent-indigo-500"
              />
              <span className="w-12 text-right font-mono text-sm text-indigo-300">
                {netPolicy.maxRetries} 次
              </span>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-400">重试间隔</span>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={1}
                max={60}
                step={1}
                value={netPolicy.retryDelaySecs}
                onChange={(e) => updateNetPolicy({ retryDelaySecs: Number(e.target.value) })}
                className="h-2 w-28 cursor-pointer appearance-none rounded-full bg-zinc-700 accent-indigo-500"
              />
              <span className="w-12 text-right font-mono text-sm text-indigo-300">
                {netPolicy.retryDelaySecs}s
              </span>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-zinc-400">重试条件（状态码/范围）</label>
            <input
              type="text"
              value={netPolicy.retryHttpStatuses}
              onChange={(e) => {
                const v = e.target.value;
                if (validateRetryHttpStatuses(v) === null) {
                  updateNetPolicy({ retryHttpStatuses: v });
                }
              }}
              placeholder="408, 429, 500-599"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className={inputClass}
            />
            {validateRetryHttpStatuses(netPolicy.retryHttpStatuses) && (
              <p className="mt-1 text-xs text-red-400">
                {validateRetryHttpStatuses(netPolicy.retryHttpStatuses)}
              </p>
            )}
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-400">首字超时（秒）</span>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={20}
                max={250}
                step={5}
                value={netPolicy.firstByteTimeoutSecs}
                onChange={(e) => updateNetPolicy({ firstByteTimeoutSecs: Number(e.target.value) })}
                className="h-2 w-28 cursor-pointer appearance-none rounded-full bg-zinc-700 accent-indigo-500"
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
            />
          </div>
        </div>
      </MobileSettingRow>

      {/* ── 渠道列表 ── */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-zinc-100">渠道</div>
            <div className="mt-0.5 text-xs leading-relaxed text-zinc-500">
              OpenAI 兼容接入点（DeepSeek / 硅基流动 / Ollama / OpenRouter 等）
            </div>
          </div>
          <button
            type="button"
            onClick={() => setChannelEditor({ open: true })}
            className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white active:bg-indigo-500"
          >
            + 添加
          </button>
        </div>

        {registry.channels.length === 0 ? (
          <p className="py-4 text-center text-sm text-zinc-500">
            还没有渠道，点击「添加」接入第一个模型服务
          </p>
        ) : (
          <div className="mt-2 divide-y divide-zinc-800">
            {registry.channels.map((ch) => {
              const models = modelsOfChannel(registry, ch.id);
              const hasKey = channelKeyStatus[ch.id] ?? !!ch.apiKey;
              const isDefault = effectiveDefault?.channelId === ch.id;
              return (
                <button
                  key={ch.id}
                  type="button"
                  onClick={() => setChannelEditor({ open: true, channel: ch })}
                  className="flex w-full items-center gap-2 py-3 text-left active:bg-zinc-800/50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm text-zinc-200">{ch.name}</span>
                      {!ch.enabled && (
                        <span className="rounded bg-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400">
                          已禁用
                        </span>
                      )}
                      {isDefault && (
                        <span className="rounded bg-indigo-600/20 px-1.5 py-0.5 text-[10px] text-indigo-300">
                          默认
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-xs text-zinc-500">
                      {ch.baseUrl || <span className="text-amber-500/80">未填写 Base URL</span>}
                    </div>
                    <div className="mt-0.5 text-[11px] text-zinc-600">
                      {models.length} 个模型 · {hasKey ? '已配置密钥' : '未配置密钥'}
                    </div>
                  </div>
                  <ChevronDown className="h-4 w-4 flex-shrink-0 rotate-[-90deg] text-zinc-600" />
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* 默认模型选择 */}
      <MobileModelPickerSheet
        open={defaultPicker}
        onClose={() => setDefaultPicker(false)}
        title="选择默认模型"
        registry={registry}
        value={effectiveDefault?.id ?? ''}
        allowEmpty={false}
        emptyLabel=""
        onChange={(modelId) =>
          updateRegistry({ ...registry, slots: { ...slots, defaultModelId: modelId } })
        }
      />

      {/* 摘要模型选择 */}
      <MobileModelPickerSheet
        open={summarizerPicker}
        onClose={() => setSummarizerPicker(false)}
        title="选择上下文压缩模型"
        registry={registry}
        value={slots.summarizerModelId}
        allowEmpty
        emptyLabel="跟随默认模型"
        onChange={(modelId) =>
          updateRegistry({ ...registry, slots: { ...slots, summarizerModelId: modelId } })
        }
      />

      {/* 渠道编辑（key 强制重挂载，重置表单为当前渠道） */}
      <MobileChannelEditorSheet
        key={channelEditor.open ? (channelEditor.channel?.id ?? 'new') : 'closed'}
        open={channelEditor.open}
        onClose={() => setChannelEditor({ open: false })}
        channel={channelEditor.channel}
        registry={registry}
        hasKey={channelEditor.channel ? (channelKeyStatus[channelEditor.channel.id] ?? false) : false}
        onSaveChannel={handleChannelSave}
        onDeleteChannel={(ch) => updateRegistry(removeChannel(registry, ch.id))}
      />
    </div>
  );
}
