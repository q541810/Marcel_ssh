import { useState, useEffect } from 'react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import Toggle from '@/components/ui/Toggle';
import ModelListModal from './ModelListModal';
import ModelEditModal, { type ModelDraft } from './ModelEditModal';
import type { ChannelConfig, LlmRegistry, ModelEntry } from '@/lib/types';
import {
  modelsOfChannel,
  modelLabel,
  createModel,
  duplicateChannelName,
  duplicateModelName,
} from '@/lib/llmRegistry';

interface Props {
  open: boolean;
  onClose: () => void;
  /** 编辑的渠道；undefined = 新建。 */
  channel?: ChannelConfig;
  registry: LlmRegistry;
  /** 该渠道的密钥是否存在（掩码占位显示用）。 */
  channelHasKey: boolean;
  /** 保存渠道 + 该渠道的模型列表（本地草稿，一次性提交，避免孤儿模型）。 */
  onSave: (channel: ChannelConfig, models: ModelEntry[]) => void;
  /** 级联删除渠道（含其模型与密钥）。 */
  onDelete: (channel: ChannelConfig) => void;
}

/** 渠道编辑草稿（与 ChannelConfig 对齐）。网络策略走全局，渠道不再持有。 */
export interface ChannelDraft {
  name: string;
  baseUrl: string;
  enabled: boolean;
}

const inputClass =
  'w-full rounded-lg bg-zinc-900 border border-zinc-700 px-3 py-1.5 text-sm font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500';

export default function ChannelEditModal({
  open,
  onClose,
  channel,
  registry,
  channelHasKey,
  onSave,
  onDelete,
}: Props) {
  const isNew = !channel;
  // 表单草稿（与 store 分离，保存时一次性提交）
  const [draft, setDraft] = useState<ChannelDraft | null>(null);
  // 渠道 ID：新建时在打开瞬间生成，模型草稿与最终渠道共用，保证引用一致
  const [draftChannelId, setDraftChannelId] = useState('');
  // 本地模型草稿：编辑/新建渠道期间增删改不落 store，保存渠道时随渠道一起提交，
  // 避免「加了模型但取消渠道」产生指向不存在渠道的孤儿模型。
  const [localModels, setLocalModels] = useState<ModelEntry[]>([]);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // 模型编辑状态
  const [modelEditor, setModelEditor] = useState<{ open: boolean; initial?: ModelEntry; preset?: string }>({
    open: false,
  });
  const [fetchPicker, setFetchPicker] = useState(false);

  // 打开时初始化草稿
  useEffect(() => {
    if (open) {
      setDraft(
        channel
          ? {
              name: channel.name,
              baseUrl: channel.baseUrl ?? '',
              enabled: channel.enabled,
            }
          : {
              name: '',
              baseUrl: '',
              enabled: true,
            },
      );
      // 编辑已有渠道：载入其现有模型；新建：空列表
      setLocalModels(channel ? modelsOfChannel(registry, channel.id) : []);
      setDraftChannelId(channel?.id ?? crypto.randomUUID());
      setApiKeyInput('');
      setLocalError(null);
      setConfirmDelete(false);
      setModelEditor({ open: false });
    }
  }, [open, channel, registry]);

  if (!draft) return null;

  const models = localModels;

  const handleSave = () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      setLocalError('渠道名称不能为空');
      return;
    }
    const dup = duplicateChannelName(registry, name, channel?.id);
    if (dup) {
      setLocalError(`渠道名「${dup}」已存在`);
      return;
    }
    const baseUrl = draft.baseUrl.trim();
    if (!baseUrl) {
      setLocalError('Base URL 不能为空，请填写 OpenAI 兼容端点');
      return;
    }
    if (!/^https?:\/\//.test(baseUrl)) {
      setLocalError('Base URL 须以 http:// 或 https:// 开头');
      return;
    }
    const next: ChannelConfig = {
      ...(channel ?? { id: draftChannelId, apiKey: '' }),
      name,
      baseUrl,
      enabled: draft.enabled,
    };
    if (apiKeyInput.trim()) {
      next.apiKey = apiKeyInput.trim();
    }
    onSave(next, localModels);
    onClose();
  };

  const handleSaveModel = (m: ModelDraft) => {
    const dup = duplicateModelName(
      registry,
      draftChannelId,
      m.modelName,
      modelEditor.initial?.id,
    );
    if (dup) {
      setLocalError(`该渠道下模型「${dup}」已存在`);
      return;
    }
    if (modelEditor.initial) {
      // 编辑已有模型：保持 id / channelId
      const updated: ModelEntry = {
        ...modelEditor.initial,
        modelName: m.modelName,
        displayName: m.displayName,
        temperature: m.temperature,
        vision: m.vision,
        contextWindow: m.contextWindow,
        extraBody: m.extraBody,
      };
      setLocalModels((prev) =>
        prev.map((x) => (x.id === updated.id ? updated : x)),
      );
    } else {
      const full: ModelEntry = {
        ...createModel(draftChannelId, m.modelName),
        displayName: m.displayName,
        temperature: m.temperature,
        vision: m.vision,
        contextWindow: m.contextWindow,
        extraBody: m.extraBody,
      };
      setLocalModels((prev) => [...prev, full]);
    }
    setModelEditor({ open: false });
  };

  const handleDeleteModel = (model: ModelEntry) => {
    setLocalModels((prev) => prev.filter((m) => m.id !== model.id));
  };

  const handleDeleteChannel = () => {
    if (!channel) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    onDelete(channel);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isNew ? '添加渠道' : `编辑渠道：${channel?.name}`}
      size="lg"
    >
      <div className="px-5 py-4 space-y-5 overflow-y-auto max-h-[70vh]">
        {/* ── 基本信息 ── */}
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-zinc-400 mb-1">渠道名称 *</label>
            <input
              type="text"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="DeepSeek 官方 / 硅基流动 / Ollama 本地"
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Base URL</label>
            <input
              type="text"
              value={draft.baseUrl}
              onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
              placeholder="https://api.deepseek.com/v1（必填）"
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1">API Key</label>
            <div className="flex gap-2">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKeyInput || (channelHasKey && !apiKeyInput ? 'sk-******' : '')}
                onChange={(e) =>
                  setApiKeyInput(e.target.value === 'sk-******' ? '' : e.target.value)
                }
                placeholder="输入 API Key（加密保存在本设备）"
                autoComplete="off"
                className={`${inputClass} flex-1`}
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="px-2.5 py-1.5 rounded-lg text-xs text-zinc-300 bg-zinc-800 hover:bg-zinc-700 transition-colors flex-shrink-0"
              >
                {showKey ? '隐藏' : '显示'}
              </button>
            </div>
            {channelHasKey && !apiKeyInput && (
              <p className="text-[11px] text-zinc-500 mt-1">
                已保存密钥（掩码显示）。留空不修改，清空需输入新值覆盖。
              </p>
            )}
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-zinc-200">启用渠道</div>
              <div className="text-[11px] text-zinc-500">禁用后该渠道所有模型不可用</div>
            </div>
            <Toggle
              checked={draft.enabled}
              onChange={(v) => setDraft({ ...draft, enabled: v })}
              label=""
            />
          </div>
        </div>

        {/* ── 模型列表 ── */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-medium text-zinc-200">
              模型列表 <span className="text-zinc-500">（{models.length}）</span>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => setFetchPicker(true)}>
                获取模型列表
              </Button>
              <Button size="sm" onClick={() => setModelEditor({ open: true })}>
                + 添加模型
              </Button>
            </div>
          </div>

          {models.length === 0 ? (
            <p className="text-xs text-zinc-500 py-3 text-center border border-dashed border-zinc-800 rounded-lg">
              还没有模型。点击「获取模型列表」从供应商拉取，或手动添加。
            </p>
          ) : (
            <ul className="divide-y divide-zinc-800 overflow-hidden rounded-xl border border-zinc-800">
              {models.map((m) => (
                <li key={m.id} className="flex items-center gap-2 px-3 py-2 bg-zinc-900/40">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-zinc-200 truncate">
                      {modelLabel(m)}
                      {m.vision && (
                        <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-indigo-600/20 text-indigo-300">
                          视觉
                        </span>
                      )}
                    </div>
                    {m.displayName && m.displayName !== m.modelName && (
                      <div className="text-[11px] text-zinc-500 font-mono truncate">{m.modelName}</div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setModelEditor({ open: true, initial: m })}
                    className="px-2 py-1 rounded text-xs text-zinc-300 hover:bg-zinc-800 transition-colors flex-shrink-0"
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteModel(m)}
                    className="px-2 py-1 rounded text-xs text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors flex-shrink-0"
                  >
                    删除
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {localError && <p className="text-sm text-red-400">{localError}</p>}

        {/* ── 底部操作 ── */}
        <div className="flex items-center justify-between pt-2">
          {!isNew ? (
            <Button variant="danger" size="sm" onClick={handleDeleteChannel}>
              {confirmDelete ? '确认删除渠道？' : '删除渠道'}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>取消</Button>
            <Button onClick={handleSave}>保存渠道</Button>
          </div>
        </div>
      </div>

      {/* 模型编辑弹窗 */}
      <ModelEditModal
        open={modelEditor.open}
        onClose={() => setModelEditor({ open: false })}
        initial={modelEditor.initial}
        presetModelName={modelEditor.preset}
        onSave={handleSaveModel}
      />

      {/* 从 /models 拉取选择 */}
      <ModelListModal
        open={fetchPicker}
        onClose={() => setFetchPicker(false)}
        channelId={channel?.id}
        currentModel=""
        baseUrl={draft.baseUrl}
        apiKey={apiKeyInput || undefined}
        onSelect={(modelId) => {
          setFetchPicker(false);
          setModelEditor({ open: true, preset: modelId });
        }}
      />
    </Modal>
  );
}
