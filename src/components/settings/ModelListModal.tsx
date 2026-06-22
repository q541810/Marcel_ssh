import { useState, useEffect, useCallback } from 'react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { llmListModels } from '@/lib/tauri';
import { getErrorMessage } from '@/lib/errors';
import type { ModelInfo } from '@/lib/types';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Currently configured model id — highlighted in the list. */
  currentModel: string;
  /** Draft baseUrl/apiKey from the form — reflects what the user sees. */
  baseUrl?: string | null;
  apiKey?: string | null;
  /** Called when the user picks a model. The modal closes itself after. */
  onSelect: (modelId: string) => void;
}

export default function ModelListModal({
  open,
  onClose,
  currentModel,
  baseUrl,
  apiKey,
  onSelect,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [filter, setFilter] = useState('');

  const fetchModels = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await llmListModels(baseUrl, apiKey);
      list.sort((a, b) => a.id.localeCompare(b.id));
      setModels(list);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [baseUrl, apiKey]);

  useEffect(() => {
    if (open) {
      setFilter('');
      void fetchModels();
    }
  }, [open, fetchModels]);

  const filterText = filter.trim().toLowerCase();
  const filtered =
    filterText === ''
      ? models
      : models.filter((m) => m.id.toLowerCase().includes(filterText));

  const handleSelect = (id: string) => {
    onSelect(id);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="获取模型列表">
      <div className="px-4 py-3 space-y-3">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="过滤模型 ID…"
          className="w-full rounded-lg bg-zinc-900 border border-zinc-700 px-3 py-1.5 text-sm font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500"
        />

        <div className="max-h-80 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900/40">
          {loading && (
            <div className="px-3 py-10 text-center text-sm text-zinc-500">
              正在从供应商获取…
            </div>
          )}

          {!loading && error && (
            <div className="px-3 py-6 space-y-3">
              <div className="text-sm text-red-400 break-words">{error}</div>
              <Button variant="secondary" size="sm" onClick={fetchModels}>
                重试
              </Button>
            </div>
          )}

          {!loading && !error && filtered.length === 0 && (
            <div className="px-3 py-10 text-center text-sm text-zinc-500">
              {models.length === 0 ? '供应商未返回任何模型' : '无匹配模型'}
            </div>
          )}

          {!loading && !error && filtered.length > 0 && (
            <div className="divide-y divide-zinc-800">
              {filtered.map((m) => {
                const isCurrent = m.id === currentModel;
                return (
                  <button
                    key={m.id}
                    onClick={() => handleSelect(m.id)}
                    className={`w-full text-left px-3 py-2 text-sm font-mono transition-colors hover:bg-zinc-700/40 ${
                      isCurrent
                        ? 'text-indigo-400 bg-indigo-600/10'
                        : 'text-zinc-200'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex-1 truncate">{m.id}</span>
                      {isCurrent && (
                        <span className="text-xs text-indigo-400 flex-shrink-0">当前</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {!loading && !error && models.length > 0 && (
          <div className="text-xs text-zinc-500">
            共 {models.length} 个模型
            {filterText !== '' && ` · 匹配 ${filtered.length} 个`}
          </div>
        )}
      </div>
    </Modal>
  );
}
