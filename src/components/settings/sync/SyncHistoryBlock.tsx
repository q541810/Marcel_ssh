import { useState } from 'react';
import { TriangleAlert, Undo2 } from 'lucide-react';
import { useSyncStore } from '@/stores/syncStore';
import { relativeTime } from '@/lib/memory';
import { getErrorMessage } from '@/lib/errors';
import { describeHistoryEntry } from '@/lib/syncModel';
import type { SyncHistoryEntry } from '@/lib/types';
import { SyncButton, type SyncVariant } from './syncUi';

/** 默认露出多少条；更早的点"查看全部"。 */
const COLLAPSED_COUNT = 8;

function ValueText({ value, empty }: { value: string | null; empty: string }) {
  if (value === null || value === '') return <span className="italic text-zinc-500">{empty}</span>;
  return <span className="break-all text-zinc-300">{value}</span>;
}

function HistoryItem({
  variant,
  entry,
  busy,
  onUndo,
}: {
  variant: SyncVariant;
  entry: SyncHistoryEntry;
  busy: boolean;
  onUndo: (entry: SyncHistoryEntry) => void;
}) {
  const view = describeHistoryEntry(entry);
  const isWarning = entry.kind === 'warning';
  // 警告条的正文：后端把它整句放在 `label` 里（「已信任主机 X 的指纹（另一台设备记录的是 Y…）」）。
  // 老记录没有 `label`，那时 `newValue` 里放的是同一句话。
  const warningText = entry.label?.trim() || entry.newValue || entry.oldValue;
  // 机密记录只写「哪个 Key 变了」，不画旧值 → 新值：值不该出现在界面上（截图 / 录屏就会漏）。
  const isSecret = view.hideValues;

  return (
    <li
      className={`py-2.5 first:pt-0 last:pb-0 ${entry.undone ? 'opacity-55' : ''} ${
        isWarning ? 'rounded-lg bg-amber-500/10 px-2.5 !py-2 my-1.5 border border-amber-500/20' : ''
      }`}
      data-kind={entry.kind}
    >
      <div className="flex items-start gap-2">
        {isWarning && <TriangleAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-400" aria-hidden />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 text-sm text-zinc-200">
            <span className="font-medium">{view.sourceLabel}</span>
            <span className="text-zinc-400">{view.fieldLabel === view.sourceLabel ? '' : view.fieldLabel}</span>
            {view.scope && (
              <span className="rounded bg-zinc-700/70 px-1.5 py-0.5 text-[10px] text-zinc-300">{view.scope}</span>
            )}
          </div>
          {isWarning ? (
            <p className="mt-0.5 text-xs leading-relaxed text-amber-200/90">
              {warningText || '这条改动没有应用到本机，请留意。'}
            </p>
          ) : isSecret ? (
            <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">
              {entry.oldValue || entry.newValue ? '已更新（内容不在这里显示）' : '已更新'}
            </p>
          ) : (
            <p className="mt-0.5 text-xs leading-relaxed">
              <ValueText value={view.oldValue} empty="（无）" />
              <span className="mx-1.5 text-zinc-500">→</span>
              <ValueText value={view.newValue} empty="（已删除）" />
            </p>
          )}
          <p className="mt-0.5 text-[11px] text-zinc-500">
            来自 {entry.deviceName} · {relativeTime(entry.at) || '时间未知'}
            {entry.undone ? ' · 已撤销' : ''}
          </p>
        </div>
        {!isWarning && !isSecret && !entry.undone && (
          <SyncButton
            variant={variant}
            kind="ghost"
            loading={busy}
            onClick={() => onUndo(entry)}
            className={variant === 'desktop' ? '!px-2 !py-1 !text-xs' : '!min-h-9 !px-3'}
            aria-label={`撤销对「${view.sourceLabel} ${view.fieldLabel}」的改动`}
          >
            <Undo2 className="h-3.5 w-3.5" aria-hidden />
            撤销
          </SyncButton>
        )}
      </div>
    </li>
  );
}

/**
 * 同步记录：别的设备对本机做了什么改动，最新的在最上面。
 * 每条可以一键撤销（把该处改回旧值）——撤销本身是一次本机改动，会再同步给其它设备，
 * 所以这里不弹确认：它随时可以再被改回去。
 */
export function HistoryList({
  variant,
  history,
  loading,
  error,
}: {
  variant: SyncVariant;
  history: SyncHistoryEntry[];
  loading: boolean;
  error: string | null;
}) {
  const undo = useSyncStore((s) => s.undo);
  const [expanded, setExpanded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);

  const onUndo = async (entry: SyncHistoryEntry) => {
    if (busyId) return;
    setBusyId(entry.id);
    setUndoError(null);
    try {
      await undo(entry.id);
    } catch (err) {
      setUndoError(getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  if (error && history.length === 0) {
    return (
      <p className="text-xs text-red-400" role="alert">
        读取同步记录失败：{error}
      </p>
    );
  }
  if (history.length === 0) {
    return (
      <p className="text-xs text-zinc-500">
        {loading ? '正在读取同步记录…' : '还没有来自其它设备的改动。别的设备改了东西之后，会在这里留下记录。'}
      </p>
    );
  }

  const shown = expanded ? history : history.slice(0, COLLAPSED_COUNT);
  return (
    <div className="space-y-2">
      {undoError && (
        <p className="text-xs text-red-400" role="alert">
          撤销失败：{undoError}
        </p>
      )}
      <ul className="divide-y divide-edge-subtle">
        {shown.map((entry) => (
          <HistoryItem
            key={entry.id}
            variant={variant}
            entry={entry}
            busy={busyId === entry.id}
            onUndo={(e) => void onUndo(e)}
          />
        ))}
      </ul>
      {history.length > COLLAPSED_COUNT && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs text-indigo-400 hover:text-indigo-300 active:text-indigo-300"
        >
          {expanded ? '收起' : `查看全部 ${history.length} 条`}
        </button>
      )}
    </div>
  );
}
