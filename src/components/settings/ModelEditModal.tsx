import { useState, useEffect } from 'react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import Toggle from '@/components/ui/Toggle';
import type { ModelEntry } from '@/lib/types';
import {
  validateExtraBodyJson,
  extraBodyToText,
  textToExtraBody,
} from '@/lib/llmParams';

interface Props {
  open: boolean;
  onClose: () => void;
  /** 初始值。undefined = 新建（空表单）。 */
  initial?: ModelEntry;
  /** 保存校验：返回错误文案或 null。 */
  validate?: (draft: ModelDraft) => string | null;
  onSave: (draft: ModelDraft) => void;
  /** 新建时的默认模型名（如从 /models 列表点选带入）。 */
  presetModelName?: string;
}

/** 模型编辑草稿（与 ModelEntry 对齐，便于复用）。 */
export interface ModelDraft {
  modelName: string;
  displayName: string;
  temperature: number;
  vision: boolean;
  contextWindow: number;
  extraBody: Record<string, unknown> | null;
}

const EXTRA_BODY_PLACEHOLDER = `{
  "thinking": { "type": "enabled" },
  "top_p": 0.9,
  "max_tokens": 4096
}`;

export default function ModelEditModal({
  open,
  onClose,
  initial,
  validate,
  onSave,
  presetModelName,
}: Props) {
  const [modelName, setModelName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [temperature, setTemperature] = useState(0.1);
  const [vision, setVision] = useState(false);
  const [contextWindow, setContextWindow] = useState(0);
  const [extraBodyText, setExtraBodyText] = useState('');
  const [extraBodyError, setExtraBodyError] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  // 「更多」折叠区：高级参数默认收起；编辑已有模型且已有自定义参数时默认展开
  const [moreOpen, setMoreOpen] = useState(false);

  // 打开时按 initial 填充（新建 = 默认值）
  useEffect(() => {
    if (open) {
      setModelName(initial?.modelName ?? presetModelName ?? '');
      setDisplayName(initial?.displayName ?? '');
      setTemperature(initial?.temperature ?? 0.1);
      setVision(initial?.vision ?? false);
      setContextWindow(initial?.contextWindow ?? 0);
      const body = extraBodyToText(initial?.extraBody);
      setExtraBodyText(body);
      setMoreOpen(body.trim() !== '');
      setExtraBodyError(null);
      setLocalError(null);
    }
  }, [open, initial, presetModelName]);

  const handleSave = () => {
    const trimmed = modelName.trim();
    if (!trimmed) {
      setLocalError('模型名称（API 模型名）不能为空');
      return;
    }
    const err = validateExtraBodyJson(extraBodyText);
    if (err) {
      setExtraBodyError(err);
      setLocalError('高级参数 JSON 不合法，请修正后再保存');
      return;
    }
    const draft: ModelDraft = {
      modelName: trimmed,
      displayName: displayName.trim(),
      temperature,
      vision,
      contextWindow: Math.max(0, Math.trunc(contextWindow)),
      extraBody: textToExtraBody(extraBodyText),
    };
    const checkErr = validate?.(draft);
    if (checkErr) {
      setLocalError(checkErr);
      return;
    }
    onSave(draft);
    onClose();
  };

  const inputClass =
    'flex-1 rounded-lg bg-zinc-900 border border-zinc-700 px-3 py-1.5 text-sm font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500';

  return (
    <Modal open={open} onClose={onClose} title={initial ? '编辑模型' : '添加模型'} size="md">
      <div className="px-4 py-4 space-y-4">
        <div>
          <label className="block text-xs text-zinc-400 mb-1">API 模型名 *</label>
          <input
            type="text"
            value={modelName}
            onChange={(e) => setModelName(e.target.value)}
            placeholder="deepseek-ai/DeepSeek-V3"
            list="model-name-suggestions"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className={`${inputClass} w-full`}
          />
          <datalist id="model-name-suggestions">
            <option value="deepseek-ai/DeepSeek-V3" />
            <option value="deepseek-chat" />
            <option value="deepseek-reasoner" />
            <option value="gpt-4o" />
            <option value="claude-opus-4-7" />
          </datalist>
        </div>

        <div>
          <label className="block text-xs text-zinc-400 mb-1">展示名（可选）</label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="DeepSeek V3"
            className={`${inputClass} w-full`}
          />
          <p className="text-[11px] text-zinc-500 mt-1">
            不填则用 API 模型名展示。
          </p>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm text-zinc-200">Temperature</div>
            <div className="text-[11px] text-zinc-500">采样温度（0-2）</div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <input
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={temperature}
              onChange={(e) => setTemperature(Math.min(2, Math.max(0, Number(e.target.value) || 0)))}
              className="w-20 rounded-lg bg-zinc-900 border border-zinc-700 px-2 py-1.5 text-sm font-mono text-zinc-100 focus:outline-none focus:border-indigo-500"
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm text-zinc-200">视觉 / 支持图片</div>
            <div className="text-[11px] text-zinc-500">模型支持多模态图片输入时开启</div>
          </div>
          <Toggle checked={vision} onChange={setVision} label="" />
        </div>

        <div>
          <label className="block text-xs text-zinc-400 mb-1">
            模型上下文窗口 (tokens) <span className="text-zinc-600">（0 = 跟随全局设置）</span>
          </label>
          <input
            type="number"
            min={0}
            step={1000}
            value={contextWindow}
            onChange={(e) => setContextWindow(Math.max(0, Math.trunc(Number(e.target.value) || 0)))}
            placeholder="0 = 仅超限后压缩"
            className={`${inputClass} w-full`}
          />
        </div>

        {/* ── 更多：高级参数（默认收起） ── */}
        <div>
          <button
            type="button"
            onClick={() => setMoreOpen((o) => !o)}
            className="flex items-center gap-2 w-full text-sm font-medium text-zinc-200 hover:text-zinc-100 transition-colors"
            aria-expanded={moreOpen}
          >
            <svg
              className={`w-3.5 h-3.5 transition-transform ${moreOpen ? 'rotate-90' : ''}`}
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
              <span className="text-[11px] text-zinc-500 font-normal">
                已设置自定义请求参数
              </span>
            )}
          </button>
          {moreOpen && (
            <div className="mt-3">
              <label className="block text-xs text-zinc-400 mb-1">
                高级：自定义请求参数（可选）
              </label>
              <textarea
                value={extraBodyText}
                onChange={(e) => {
                  setExtraBodyText(e.target.value);
                  setExtraBodyError(validateExtraBodyJson(e.target.value));
                }}
                placeholder={EXTRA_BODY_PLACEHOLDER}
                spellCheck={false}
                rows={5}
                className={`w-full rounded-lg px-3 py-2 text-xs font-mono text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500 resize-y ${
                  extraBodyError
                    ? 'bg-red-900/20 border border-red-500/50'
                    : 'bg-zinc-900 border border-zinc-700'
                }`}
              />
              {extraBodyError && <p className="text-xs text-red-400 mt-1">{extraBodyError}</p>}
              <p className="text-[11px] text-zinc-500 mt-1">
                以 JSON 对象形式追加到请求体（如 thinking、top_p）。执行前模型审批不会携带这些参数。
              </p>
            </div>
          )}
        </div>

        {localError && <p className="text-sm text-red-400">{localError}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button onClick={handleSave}>保存</Button>
        </div>
      </div>
    </Modal>
  );
}
