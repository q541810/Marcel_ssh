import { useEffect, useState } from 'react';
import Modal from '@/components/ui/Modal';
import type { SavedConnection } from '@/lib/types';
import { useHostMemoryCount } from '@/components/memory/useHostMemoryCount';

interface Props {
  connection: SavedConnection | null;
  onClose: () => void;
  onConfirm: (connection: SavedConnection, deleteMemories: boolean) => void;
}

/**
 * 删除连接的确认框。这台机器有长期记忆时多一个复选框：同时删掉，或者留着
 * （留下的会出现在「设置 → 记忆 → 已删除的连接」里，之后再决定）。
 */
export default function DeleteConnectionDialog({ connection, onClose, onConfirm }: Props) {
  const memoryCount = useHostMemoryCount(connection?.id ?? null);
  const [deleteMemories, setDeleteMemories] = useState(false);
  useEffect(() => {
    if (connection) setDeleteMemories(false);
  }, [connection]);

  return (
    <Modal open={!!connection} onClose={onClose} title="删除连接" size="sm">
      <div className="flex flex-col gap-4 px-4 pb-4 pt-4">
        <p className="text-read text-fg-secondary">
          确定要删除连接「{connection?.name}」吗？
        </p>
        {memoryCount > 0 && (
          <label className="flex cursor-pointer items-start gap-2.5 text-read text-fg-secondary">
            <input
              type="checkbox"
              checked={deleteMemories}
              onChange={(e) => setDeleteMemories(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-red-500"
            />
            <span>
              同时删除这台机器的 {memoryCount} 条记忆
              <span className="mt-0.5 block text-meta text-fg-tertiary">
                不删的话会留在「设置 → 记忆 → 已删除的连接」里
              </span>
            </span>
          </label>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-read text-fg-secondary hover:bg-state-mid/60 active:scale-[0.97] transition"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => connection && onConfirm(connection, deleteMemories)}
            className="rounded-lg bg-red-600 px-4 py-2 text-read font-medium text-white hover:bg-red-500 active:scale-[0.97] transition"
          >
            删除
          </button>
        </div>
      </div>
    </Modal>
  );
}
