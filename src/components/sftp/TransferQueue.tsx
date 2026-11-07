import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowUpFromLine,
  ArrowDownToLine,
  FolderUp,
  Check,
  X,
  Clock,
} from 'lucide-react';
import {
  useTransferStore,
  isFinished,
  type StoredTransferItem,
} from '@/stores/transferStore';
import { cancelTransfer } from '@/stores/transferScheduler';

function KindIcon({ item }: { item: StoredTransferItem }) {
  if (item.kind === 'download') {
    return <ArrowDownToLine size={16} strokeWidth={1.5} className="text-emerald-400 flex-shrink-0" />;
  }
  if (item.kind === 'folder-upload') {
    return <FolderUp size={16} strokeWidth={1.5} className="text-indigo-400 flex-shrink-0" />;
  }
  return <ArrowUpFromLine size={16} strokeWidth={1.5} className="text-indigo-400 flex-shrink-0" />;
}

function StatusIndicator({ item }: { item: StoredTransferItem }) {
  if (item.status === 'queued') {
    return (
      <span className="flex items-center gap-1 text-caption text-fg-tertiary flex-shrink-0">
        <Clock size={14} strokeWidth={1.5} />
        排队中
      </span>
    );
  }
  if (item.status === 'active' || item.status === 'cancelling') {
    return (
      <svg className="w-3.5 h-3.5 flex-shrink-0 text-indigo-400 animate-spin" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
      </svg>
    );
  }
  if (item.status === 'done') {
    return <Check size={16} strokeWidth={1.5} className="text-emerald-400 flex-shrink-0" />;
  }
  return (
    <X
      className={`w-3.5 h-3.5 flex-shrink-0 ${item.status === 'error' ? 'text-red-400' : 'text-fg-secondary'}`}
    />
  );
}

function statusTextClass(item: StoredTransferItem): string {
  if (item.status === 'error') return 'text-red-300';
  if (item.status === 'done') return 'text-emerald-300';
  if (item.status === 'cancelled') return 'text-fg-tertiary';
  return item.kind === 'download' ? 'text-emerald-300' : 'text-indigo-300';
}

function canCancel(item: StoredTransferItem): boolean {
  if (item.status === 'queued') return true;
  if (item.status !== 'active') return false;
  // 远端解压阶段不可中断
  return !(item.kind === 'folder-upload' && item.phase === 'extracting');
}

function TransferRow({
  item,
  onCancel,
  onRemove,
}: {
  item: StoredTransferItem;
  onCancel: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const showProgress =
    (item.status === 'active' || item.status === 'cancelling') && item.total > 0;
  const pct = item.total > 0 ? Math.min(100, Math.round((item.written * 100) / item.total)) : 0;

  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      <div className="flex items-center gap-2 min-w-0">
        <KindIcon item={item} />
        {item.source === 'agent' && (
          <span
            className="flex-shrink-0 text-caption px-1 py-px rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 font-medium leading-tight"
            title="Agent 发起"
          >
            AI
          </span>
        )}
        <span className="flex-1 min-w-0 truncate text-body text-fg" title={item.fileName}>
          {item.fileName}
        </span>
        <StatusIndicator item={item} />
        {canCancel(item) && (
          <button
            type="button"
            onClick={() => onCancel(item.id)}
            className="h-5 inline-flex items-center rounded-md bg-state-soft px-2 text-caption text-fg-secondary pressable focus-ring hover:bg-red-900/60 hover:text-red-300 transition-colors flex-shrink-0"
            title={item.kind === 'download' ? '取消下载' : '取消上传'}
          >
            取消
          </button>
        )}
        {isFinished(item.status) && (
          <button
            type="button"
            onClick={() => onRemove(item.id)}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-fg-tertiary hover:bg-state-soft hover:text-fg transition-colors pressable focus-ring flex-shrink-0"
            title="移除记录"
            aria-label="移除记录"
          >
            <X size={14} strokeWidth={1.5} />
          </button>
        )}
      </div>
      <div className={`text-caption truncate ${statusTextClass(item)}`} title={item.statusText}>
        {item.statusText}
      </div>
      {showProgress && (
        <div className="w-full h-1 rounded-full bg-state-mid overflow-hidden">
          <div
            className={`h-full rounded-full transition-[width] duration-200 ${item.kind === 'download' ? 'bg-emerald-500' : 'bg-indigo-500'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

interface Props {
  open: boolean;
  onClose: () => void;
}

/** 纯展示层：按 order 排好的列表 + 回调。独立导出便于测试（不依赖 store 快照）。 */
export function TransferCenterView({
  list,
  onClose,
  onClear,
  onCancel,
  onRemove,
}: {
  list: StoredTransferItem[];
  onClose: () => void;
  onClear: () => void;
  onCancel: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const hasFinished = list.some((item) => isFinished(item.status));

  return (
    <div className="fixed left-16 bottom-2 z-50 w-[360px] max-h-[60vh] flex flex-col surface-glass rounded-xl modal-panel-enter">
      <div className="flex items-center gap-2 px-3 py-2">
        <h3 className="flex-1 text-title text-fg">传输中心</h3>
        {hasFinished && (
          <button
            type="button"
            onClick={onClear}
            className="h-6 inline-flex items-center rounded-md px-2 text-meta text-fg-secondary hover:bg-state-soft hover:text-fg transition-colors pressable focus-ring"
          >
            清除已完成
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-fg-tertiary hover:bg-state-soft hover:text-fg transition-colors pressable focus-ring"
          title="关闭"
          aria-label="关闭"
        >
          <X size={16} strokeWidth={1.5} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {list.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-8 text-center">
            <div className="w-12 h-12 rounded-full bg-surface-raised flex items-center justify-center mb-3">
              <ArrowUpFromLine size={20} strokeWidth={1.5} className="text-fg-tertiary" />
            </div>
            <p className="text-body text-fg-secondary">暂无传输任务</p>
          </div>
        ) : (
          list.map((item) => (
            <TransferRow key={item.id} item={item} onCancel={onCancel} onRemove={onRemove} />
          ))
        )}
      </div>
    </div>
  );
}

/** 面板主体，连接 store 并注入回调。 */
export function TransferCenterPanel({ onClose }: { onClose: () => void }) {
  const items = useTransferStore((s) => s.items);
  const order = useTransferStore((s) => s.order);
  const clearFinished = useTransferStore((s) => s.clearFinished);
  const removeItem = useTransferStore((s) => s.removeItem);

  const list = order.map((id) => items[id]);

  return (
    <TransferCenterView
      list={list}
      onClose={onClose}
      onClear={clearFinished}
      onCancel={cancelTransfer}
      onRemove={removeItem}
    />
  );
}

export default function TransferQueue({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden="true" />
      <TransferCenterPanel onClose={onClose} />
    </>,
    document.body,
  );
}
