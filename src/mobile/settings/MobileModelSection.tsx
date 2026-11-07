import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import type { AgentModeSettings, ChannelConfig, LlmRegistry, ModelEntry, ModelInfo, NetPolicy, SubagentModelChoice } from '@/lib/types';
import { llmListModels, getLlmChannelHeaders, saveLlmChannelHeaders } from '@/lib/tauri';
import HeaderPairEditor from '@/components/settings/HeaderPairEditor';
import { type HeaderPair, headersToPairs, pairsToHeaders } from '@/lib/channelHeaders';
import { getErrorMessage } from '@/lib/errors';
import Toggle from '@/components/ui/Toggle';
import { useSettingsActions } from '@/components/settings/SettingsActionsContext';
import { contextWindowHint } from '@/lib/contextWindowHints';
import { validateRetryHttpStatuses, validateExtraBodyJson, extraBodyToText, textToExtraBody, textToEfforts } from '@/lib/llmParams';
import {
  modelsOfChannel,
  modelLabel,
  modelFullLabel,
  createModel,
  emptyRegistry,
  removeChannel,
  duplicateChannelName,
  duplicateModelName,
  mergeChannelModels,
  modelOptionsByChannel,
  candidateRowModelLabel,
  shiftChannel,
} from '@/lib/llmRegistry';
import MobileSheet from '../ui/MobileSheet';
import YegouApiBanner from '@/components/settings/YegouApiBanner';
import { MobileSettingRow } from './MobileSettingRow';

const inputClass =
  'w-full rounded-lg field px-3 py-2.5 font-mono text-body text-fg';

/** 候选的选型提示是中文散文，不用渠道/模型字段那套等宽字体。 */
const descriptionInputClass =
  'w-full rounded-lg field px-3 py-2.5 text-body text-fg';

/** 空注册表兜底（settings 尚未初始化时）：用 lib/llmRegistry 的共享版。 */

/** 模型选择底部弹层（辅助场景槽位选择用）。 */
export function MobileModelPickerSheet({
  open,
  onClose,
  title,
  registry,
  value,
  allowEmpty,
  emptyLabel,
  excludeModelIds,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  registry: LlmRegistry;
  value: string;
  allowEmpty: boolean;
  emptyLabel: string;
  /** 已被其他候选行占用的模型 id（这些行禁选，防同一模型配两条候选）。
   *  不传 = 不过滤（摘要槽位等单选场景）。 */
  excludeModelIds?: ReadonlySet<string>;
  onChange: (modelId: string) => void;
}) {
  const models = registry.models;
  const occupied = excludeModelIds;
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
            className="flex w-full items-center justify-between rounded-lg px-3 py-3 text-left text-body active:bg-state-soft"
          >
            <span className="text-fg">{emptyLabel}</span>
            {!value && <span className="text-meta text-indigo-400">当前</span>}
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
                <span className="truncate text-caption font-medium uppercase tracking-wide text-fg-tertiary">
                  {ch.name}
                </span>
                {channelDisabled && (
                  <span className="flex-shrink-0 rounded bg-zinc-700 px-1 py-0.5 text-caption text-fg-secondary">
                    已禁用
                  </span>
                )}
              </div>
              <div className="divide-y divide-edge-subtle/70">
                {channelModels.map((m) => {
                  const selected = value === m.id;
                  const occupiedHere = !selected && occupied?.has(m.id);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      disabled={channelDisabled || occupiedHere}
                      onClick={() => {
                        onChange(m.id);
                        onClose();
                      }}
                      className={`flex w-full items-center justify-between gap-2 px-3 py-3 text-left active:bg-state-soft ${
                        channelDisabled || occupiedHere ? "opacity-40" : ""
                      }`}
                    >
                      <span className="min-w-0 truncate text-body text-fg">
                        {modelLabel(m)}
                      </span>
                      {selected && (
                        <span className="flex-shrink-0 text-meta text-indigo-400">当前</span>
                      )}
                      {occupiedHere && (
                        <span className="flex-shrink-0 text-meta text-fg-tertiary">
                          已用于其他候选
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
        {models.length === 0 && (
          <p className="py-6 text-center text-body text-fg-tertiary">
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
  const [effortsText, setEffortsText] = useState(
    (initial?.reasoningEfforts ?? []).join('\n'),
  );
  const [demoteNonLeadingSystem, setDemoteNonLeadingSystem] = useState(
    initial?.demoteNonLeadingSystem ?? false,
  );
  // 「更多」折叠区：高级参数默认收起；编辑已有模型且已设置高级参数/思考档位/兼容开关时默认展开
  const [moreOpen, setMoreOpen] = useState(
    extraBodyToText(initial?.extraBody).trim() !== '' ||
      (initial?.reasoningEfforts ?? []).join('').trim() !== '' ||
      (initial?.demoteNonLeadingSystem ?? false),
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
          reasoningEfforts: textToEfforts(effortsText),
          demoteNonLeadingSystem,
        }
      : {
          ...createModel(channelId, trimmed),
          displayName: displayName.trim(),
          vision,
          contextWindow: Math.max(0, Math.trunc(contextWindow)),
          extraBody: textToExtraBody(extraBodyText),
          reasoningEfforts: textToEfforts(effortsText),
          demoteNonLeadingSystem,
        };
    onSaved(model);
    onClose();
  };

  return (
    <MobileSheet open={open} onClose={onClose} title={title}>
      <div className="space-y-3 px-4 pb-4">
        <div>
          <label className="mb-1 block text-meta text-fg-secondary">API 模型名 *</label>
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
          <label className="mb-1 block text-meta text-fg-secondary">展示名（可选）</label>
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
            <div className="text-body text-fg">视觉 / 支持图片</div>
            <div className="text-caption text-fg-tertiary">模型支持多模态时开启</div>
          </div>
          <Toggle checked={vision} onChange={setVision} />
        </div>
        <div>
          <label className="mb-1 block text-meta text-fg-secondary">
            模型上下文窗口 (tokens) <span className="text-fg-disabled">（0 = 跟随全局）</span>
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
            className="flex w-full items-center gap-2 py-1 text-body font-medium text-fg active:text-fg"
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
            {(extraBodyText.trim() !== '' ||
              effortsText.trim() !== '' ||
              demoteNonLeadingSystem) && (
              <span className="text-caption font-normal text-fg-tertiary">
                已设置高级参数
              </span>
            )}
          </button>
          {moreOpen && (
            <div className="mt-1 space-y-3">
              <div>
                <label className="mb-1 block text-meta text-fg-secondary">
                  思考强度档位 <span className="text-fg-disabled">（从低到高，每行一个；留空不启用）</span>
                </label>
                <textarea
                  value={effortsText}
                  onChange={(e) => setEffortsText(e.target.value)}
                  placeholder={'low\nmedium\nhigh'}
                  spellCheck={false}
                  rows={3}
                  className="w-full resize-y rounded-lg field px-3 py-2 font-mono text-meta text-fg"
                />
                <p className="mt-1 text-caption leading-relaxed text-fg-tertiary">
                  填写该模型支持的推理档位（如 low/medium/high、max）。填了之后，会话输入条模型名旁会出现
                  强度选择器，所选档位作为请求体顶层 reasoning_effort 透传。留空则该模型不参与强度选择。
                </p>
              </div>

              <div>
                <label className="mb-1 block text-meta text-fg-secondary">
                  高级：自定义请求参数（可选）
                </label>
                <textarea
                  value={extraBodyText}
                  onChange={(e) => setExtraBodyText(e.target.value)}
                  placeholder={`{\n  "thinking": { "type": "enabled" },\n  "top_p": 0.9\n}`}
                  spellCheck={false}
                  rows={4}
                  className="w-full resize-y rounded-lg field px-3 py-2 font-mono text-meta text-fg"
                />
                <p className="text-caption text-fg-tertiary">
                  以 JSON 对象形式追加到请求体（如 thinking、top_p）。执行前模型审批不会携带这些参数。
                </p>
              </div>

              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-body text-fg">非首位系统消息转为普通消息</div>
                  <div className="text-caption leading-relaxed text-fg-tertiary">
                    严格模板后端兼容：对话中后段的系统消息（如当前计划状态）会以普通消息身份发送，
                    并在开头注明「系统消息，非用户发言」；开启后每条多一行声明的开销
                  </div>
                </div>
                <Toggle
                  checked={demoteNonLeadingSystem}
                  onChange={setDemoteNonLeadingSystem}
                />
              </div>
            </div>
          )}
        </div>
        {error && <p className="text-body text-red-400">{error}</p>}
        <div className="flex gap-2 pt-1">
          {initial && (
            <button
              type="button"
              onClick={() => {
                onDeleted(initial.id);
                onClose();
              }}
              className="flex-shrink-0 rounded-lg bg-red-900/40 px-4 py-2.5 text-body text-red-300 active:bg-red-900/60"
            >
              删除
            </button>
          )}
          <button
            type="button"
            onClick={handleSave}
            className="flex-1 rounded-lg bg-indigo-600 px-4 py-2.5 text-body font-medium text-white active:bg-indigo-500"
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
  // 自定义请求头草稿（存密钥链，不在 registry 里，挂载时异步读一次）
  const [headerPairs, setHeaderPairs] = useState<HeaderPair[]>([]);

  const [modelEditor, setModelEditor] = useState<{ open: boolean; initial?: ModelEntry; preset?: string }>({
    open: false,
  });
  const [fetchOpen, setFetchOpen] = useState(false);
  const [fetchLoading, setFetchLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetchedModels, setFetchedModels] = useState<ModelInfo[]>([]);
  const [fetchFilter, setFetchFilter] = useState('');

  // 自定义请求头存在密钥链里，不在 registry 里，挂载时异步读一次。
  useEffect(() => {
    if (!channel) return;
    let alive = true;
    getLlmChannelHeaders(channel.id)
      .then((headers) => {
        if (alive) setHeaderPairs(headersToPairs(headers ?? {}));
      })
      .catch((err) => {
        console.warn('读取渠道自定义请求头失败:', getErrorMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [channel]);

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
    // 自定义请求头存密钥链（不进 registry）；失败只记日志，不阻断渠道保存。
    saveLlmChannelHeaders(next.id, pairsToHeaders(headerPairs)).catch((err) => {
      console.error('保存自定义请求头失败:', getErrorMessage(err));
    });
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
          <label className="mb-1 block text-meta text-fg-secondary">渠道名称 *</label>
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
          <label className="mb-1 block text-meta text-fg-secondary">Base URL</label>
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
          <label className="mb-1 block text-meta text-fg-secondary">API Key</label>
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
            <p className="mt-1 text-caption text-fg-tertiary">已保存密钥（掩码显示），留空不修改</p>
          )}
        </div>

        <div className="flex items-center justify-between">
          <div>
            <div className="text-body text-fg">启用渠道</div>
            <div className="text-caption text-fg-tertiary">禁用后该渠道所有模型不可用</div>
          </div>
          <Toggle checked={enabled} onChange={setEnabled} />
        </div>

        <HeaderPairEditor pairs={headerPairs} onChange={setHeaderPairs} />

        {/* 模型列表 */}
        <div className="rounded-xl border border-edge-subtle bg-surface/40 px-3 py-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-body font-medium text-fg">
              模型 <span className="text-fg-tertiary">（{models.length}）</span>
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setFetchOpen(true);
                  setFetchFilter('');
                  void fetchModels();
                }}
                className="rounded-lg bg-fill px-3 py-1.5 text-caption text-fg active:bg-state-mid hit-area"
              >
                获取列表
              </button>
              <button
                type="button"
                onClick={() => setModelEditor({ open: true })}
                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-caption text-white active:bg-indigo-500 hit-area"
              >
                + 添加
              </button>
            </div>
          </div>
          {models.length === 0 ? (
            <p className="py-3 text-center text-meta text-fg-tertiary">
              还没有模型。可「获取列表」从供应商拉取，或手动添加。
            </p>
          ) : (
            <div className="divide-y divide-edge-subtle">
              {models.map((m) => (
                <div key={m.id} className="flex items-center gap-2 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-body text-fg">
                      {modelLabel(m)}
                      {m.vision && (
                        <span className="ml-2 rounded bg-indigo-600/20 px-1.5 py-0.5 text-caption text-indigo-300">
                          视觉
                        </span>
                      )}
                    </div>
                    {m.displayName && m.displayName !== m.modelName && (
                      <div className="truncate font-mono text-caption text-fg-tertiary">{m.modelName}</div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setModelEditor({ open: true, initial: m })}
                    className="rounded-lg bg-fill px-2.5 py-1.5 text-caption text-fg-secondary active:bg-state-mid hit-area"
                  >
                    编辑
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {error && <p className="text-body text-red-400">{error}</p>}

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
              className="flex-shrink-0 rounded-lg bg-red-900/40 px-4 py-2.5 text-body text-red-300 active:bg-red-900/60"
            >
              {confirmDelete ? '确认删除渠道？' : '删除渠道'}
            </button>
          )}
          <button
            type="button"
            onClick={handleSave}
            className="flex-1 rounded-lg bg-indigo-600 px-4 py-2.5 text-body font-medium text-white active:bg-indigo-500"
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
            <div className="flex items-center justify-center gap-2 py-8 text-body text-fg-tertiary">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在从供应商获取…
            </div>
          )}
          {!fetchLoading && fetchError && (
            <div className="space-y-3 py-4">
              <p className="break-words text-body text-red-400">{fetchError}</p>
              <button
                type="button"
                onClick={() => void fetchModels()}
                className="w-full rounded-lg bg-fill px-3 py-2.5 text-body text-fg active:bg-state-mid"
              >
                重试
              </button>
            </div>
          )}
          {!fetchLoading && !fetchError && filtered.length === 0 && (
            <p className="py-8 text-center text-body text-fg-tertiary">
              {fetchedModels.length === 0 ? '供应商未返回任何模型' : '无匹配模型'}
            </p>
          )}
          {!fetchLoading && !fetchError && filtered.length > 0 && (
            <div className="divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-subtle">
              {filtered.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    setFetchOpen(false);
                    // 预填模型名进入新建模型表单
                    setModelEditor({ open: true, initial: undefined, preset: m.id });
                  }}
                  className="flex w-full items-center gap-2 px-3 py-3 text-left font-mono text-body text-fg active:bg-state-soft"
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

  const [summarizerPicker, setSummarizerPicker] = useState(false);
  // 正在为第几条子agent 候选选模型（null = 弹层关闭）
  const [choicePicker, setChoicePicker] = useState<number | null>(null);
  const [channelEditor, setChannelEditor] = useState<{ open: boolean; channel?: ChannelConfig }>({
    open: false,
  });

  const updateRegistry = (next: LlmRegistry) => update({ llmRegistry: next });

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
    // 新行预选第一个**未被其他行占用**的启用渠道模型（与桌面同走
    // modelOptionsByChannel 口径）：不让同一模型出现在两条候选里
    const occupied = new Set(subagentChoices.map((c) => c.modelId));
    const firstFree = modelOptionsByChannel(registry)
      .flatMap((g) => g.options)
      .find((o) => !occupied.has(o.value));
    updateRegistry({
      ...registry,
      subagentModels: [...subagentChoices, { modelId: firstFree?.value ?? '', description: '' }],
    });
  };

  // 「添加候选」还有没有意义：无可用模型 → 提示先加渠道；全部模型已被占用 →
  // 提示清单已满（与桌面同语义）。
  const availableForNew = (() => {
    const occupied = new Set(subagentChoices.map((c) => c.modelId));
    return modelOptionsByChannel(registry)
      .flatMap((g) => g.options)
      .filter((o) => !occupied.has(o.value));
  })();

  const removeSubagentChoice = (index: number) => {
    updateRegistry({
      ...registry,
      subagentModels: subagentChoices.filter((_, i) => i !== index),
    });
  };

  // 「添加候选」三态的判定基底（与桌面同语义）：有启用渠道下的可用模型，
  // 才有资格谈占用/满员。
  const hasEnabledChannelModels = registry.channels.some(
    (ch) => ch.enabled && modelsOfChannel(registry, ch.id).length > 0,
  );

  const updateNetPolicy = (patch: Partial<NetPolicy>) => {
    updateRegistry({ ...registry, netPolicy: { ...netPolicy, ...patch } });
  };

  const handleChannelSave = (channel: ChannelConfig, channelModels: ModelEntry[]) => {
    // 本渠道模型整体替换为草稿 + 按 id 去重 + 槽位/最近使用清理（桌面/移动端共用）
    updateRegistry(mergeChannelModels(registry, channel, channelModels));
  };

  return (
    <div className="flex flex-col gap-2">
      <MobileSettingRow
        label="上下文压缩模型"
        description="压缩历史时的摘要模型。留空 = 跟随会话正在使用的模型"
      >
        <button
          type="button"
          onClick={() => setSummarizerPicker(true)}
          className="mt-2 flex w-full items-center justify-between gap-2 rounded-lg border border-edge bg-fill px-3 py-2.5 text-body text-fg active:bg-state-mid"
        >
          <span className="truncate">
            {slots.summarizerModelId
              ? modelFullLabel(registry, slots.summarizerModelId)
              : '跟随会话模型'}
          </span>
          <ChevronDown className="h-4 w-4 flex-shrink-0 text-fg-tertiary" />
        </button>
      </MobileSettingRow>

      <MobileSettingRow
        label="子agent 模型候选"
        description="主 agent 派发子agent 时可从这份清单按任务难度自选模型，每条写一句适用场景作为选型提示。未配置时，子agent 恒使用当前会话的模型"
      >
        <div className="mt-2 w-full space-y-2">
          {subagentChoices.length === 0 ? (
            <p className="text-meta leading-relaxed text-fg-tertiary">
              清单为空：子agent 跟随当前会话的模型。添加候选后，主 agent 会按描述自行选型。
            </p>
          ) : (
            subagentChoices.map((choice, i) => {
              const occupiedElsewhere = new Set(
                subagentChoices.filter((_, ci) => ci !== i).map((c) => c.modelId),
              );
              // 与桌面同一套状态标注（llmRegistry.ts 共享函数）：渠道禁用/
              // 被其他行占用/悬挂引用都要让用户看懂「这条为什么不参与派发」。
              const triggerLabel = choice.modelId
                ? (candidateRowModelLabel(registry, choice.modelId, occupiedElsewhere) ??
                  '已失效的模型')
                : '选择模型';
              return (
              <div
                key={i}
                className="space-y-2 rounded-lg border border-edge-subtle bg-surface/40 p-2"
              >
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setChoicePicker(i)}
                    className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-lg border border-edge bg-fill px-3 py-2 text-body text-fg active:bg-state-mid"
                  >
                    <span className="truncate">{triggerLabel}</span>
                    <ChevronDown className="h-4 w-4 flex-shrink-0 text-fg-tertiary" />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeSubagentChoice(i)}
                    className="flex-shrink-0 rounded-lg bg-fill px-2.5 py-1.5 text-caption text-fg-secondary active:bg-state-mid hit-area"
                  >
                    移除
                  </button>
                </div>
                <input
                  type="text"
                  value={choice.description}
                  onChange={(e) => updateSubagentChoice(i, { description: e.target.value })}
                  placeholder="选型提示，如：小模型，适合搜索等简单任务"
                  className={descriptionInputClass}
                />
              </div>
              );
            })
          )}
          {hasEnabledChannelModels ? (
            availableForNew.length > 0 ? (
              <button
                type="button"
                onClick={addSubagentChoice}
                className="w-full rounded-lg border border-dashed border-edge px-3 py-2 text-body text-fg-secondary active:bg-state-soft"
              >
                + 添加候选
              </button>
            ) : (
              <p className="text-meta text-fg-disabled">全部可用模型都已在清单里。</p>
            )
          ) : registry.models.length > 0 ? (
            <p className="text-meta text-fg-disabled">所有渠道均已禁用，启用后才能配置候选。</p>
          ) : (
            <p className="text-meta text-fg-disabled">先在下方添加渠道与模型，才能配置候选。</p>
          )}
        </div>
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
            return hint ? <p className="text-meta leading-relaxed text-fg-tertiary">{hint}</p> : null;
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
            <span className="text-meta text-fg-secondary">最大重试次数</span>
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
              <span className="w-12 text-right font-mono text-body text-indigo-300">
                {netPolicy.maxRetries} 次
              </span>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-meta text-fg-secondary">重试间隔</span>
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
              <span className="w-12 text-right font-mono text-body text-indigo-300">
                {netPolicy.retryDelaySecs}s
              </span>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-meta text-fg-secondary">重试条件（状态码/范围）</label>
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
              <p className="mt-1 text-meta text-red-400">
                {validateRetryHttpStatuses(netPolicy.retryHttpStatuses)}
              </p>
            )}
          </div>
          <div className="flex items-center justify-between">
            <span className="text-meta text-fg-secondary">首字超时（秒）</span>
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
              <span className="w-12 text-right font-mono text-body text-indigo-300">
                {netPolicy.firstByteTimeoutSecs}s
              </span>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-meta text-fg-secondary">超时自动重试</span>
            <Toggle
              checked={netPolicy.retryOnTimeout}
              onChange={(v) => updateNetPolicy({ retryOnTimeout: v })}
            />
          </div>
        </div>
      </MobileSettingRow>

      {/* ── 渠道列表 ── */}
      <div className="rounded-xl border border-edge-subtle bg-surface px-3 py-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-body font-medium text-fg">渠道</div>
            <div className="mt-0.5 text-meta leading-relaxed text-fg-tertiary">
              OpenAI 兼容接入点（DeepSeek / 硅基流动 / Ollama / OpenRouter 等）
            </div>
          </div>
          <button
            type="button"
            onClick={() => setChannelEditor({ open: true })}
            className="rounded-lg bg-indigo-600 px-3 py-2 text-body font-medium text-white active:bg-indigo-500"
          >
            + 添加
          </button>
        </div>

        {registry.channels.length === 0 ? (
          <p className="py-4 text-center text-body text-fg-tertiary">
            还没有渠道，点击「添加」接入第一个模型服务
          </p>
        ) : (
          <div className="mt-2 divide-y divide-edge-subtle">
            {registry.channels.map((ch, idx) => {
              const models = modelsOfChannel(registry, ch.id);
              const hasKey = channelKeyStatus[ch.id] ?? !!ch.apiKey;
              const isFirst = idx === 0;
              const isLast = idx === registry.channels.length - 1;
              return (
                <div key={ch.id} className="flex items-center gap-1 py-2">
                  {/* 编辑入口（占满中间） */}
                  <button
                    type="button"
                    onClick={() => setChannelEditor({ open: true, channel: ch })}
                    className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left active:bg-state-soft/50"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-body text-fg">{ch.name}</span>
                        {!ch.enabled && (
                          <span className="rounded bg-zinc-700 px-1.5 py-0.5 text-caption text-fg-secondary">
                            已禁用
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-meta text-fg-tertiary">
                        {ch.baseUrl || <span className="text-amber-500/80">未填写 Base URL</span>}
                      </div>
                      <div className="mt-0.5 text-caption text-fg-disabled">
                        {models.length} 个模型 · {hasKey ? '已配置密钥' : '未配置密钥'}
                      </div>
                    </div>
                    <ChevronDown className="h-4 w-4 flex-shrink-0 rotate-[-90deg] text-fg-disabled" />
                  </button>
                  {/* 手动排序（与桌面同语义：数组顺序 = 展示顺序） */}
                  {/* 每个按钮触控区 38×38，比图标本身大，便于手指点中 */}
                  <div className="flex flex-col flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => updateRegistry(shiftChannel(registry, ch.id, -1))}
                      disabled={isFirst}
                      aria-label={`上移 ${ch.name}`}
                      className="flex h-[38px] w-[38px] items-center justify-center rounded text-fg-secondary active:bg-state-mid disabled:opacity-30"
                    >
                      <ChevronUp className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => updateRegistry(shiftChannel(registry, ch.id, 1))}
                      disabled={isLast}
                      aria-label={`下移 ${ch.name}`}
                      className="flex h-[38px] w-[38px] items-center justify-center rounded text-fg-secondary active:bg-state-mid disabled:opacity-30"
                    >
                      <ChevronDown className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <YegouApiBanner className="mt-3" />
      </div>

      {/* 摘要模型选择 */}
      <MobileModelPickerSheet
        open={summarizerPicker}
        onClose={() => setSummarizerPicker(false)}
        title="选择上下文压缩模型"
        registry={registry}
        value={slots.summarizerModelId}
        allowEmpty
        emptyLabel="跟随会话模型"
        onChange={(modelId) =>
          updateRegistry({ ...registry, slots: { ...slots, summarizerModelId: modelId } })
        }
      />

      {/* 子agent 候选的模型选择（choicePicker = 候选行下标；已用于其他
          候选行的模型禁选，防同一模型配两条候选） */}
      <MobileModelPickerSheet
        open={choicePicker !== null}
        onClose={() => setChoicePicker(null)}
        title="选择候选模型"
        registry={registry}
        value={choicePicker !== null ? (subagentChoices[choicePicker]?.modelId ?? '') : ''}
        allowEmpty={false}
        emptyLabel=""
        excludeModelIds={
          choicePicker !== null
            ? new Set(subagentChoices.filter((_, i) => i !== choicePicker).map((c) => c.modelId))
            : undefined
        }
        onChange={(modelId) => {
          if (choicePicker !== null) updateSubagentChoice(choicePicker, { modelId });
        }}
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
