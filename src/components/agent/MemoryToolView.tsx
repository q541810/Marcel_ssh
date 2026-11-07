import { memo, useEffect, useMemo, useState } from 'react';
import type { AgentMessage } from '@/lib/types';
import { getErrorMessage } from '@/lib/errors';
import { collectPlatformHints, isMobilePlatform } from '@/platform';
import type { MemoryItem, MemoryOpKind } from '@/lib/memory';
import { useMemoryStore } from '@/stores/memoryStore';
import MemoryEditDialog from '@/components/memory/MemoryEditDialog';
import ToolCallCard from './ToolCallCard';
import { ToolCardFrame, ToolChip } from './toolCardChrome';
import { useMessageViewState } from './messageViewState';
import type { ToolViewProps } from './toolViews';

/** 后端 `memory` 工具结果里的 `metadata.memory`（`agent/tools/memory.rs::op_metadata`）。 */
interface MemoryToolMeta {
  op: MemoryOpKind;
  opId: number;
  batchId: string;
  memoryId: string;
  scopeLabel: string;
  before: MemoryItem | null;
  after: MemoryItem | null;
}

function readMeta(message: AgentMessage): MemoryToolMeta | null {
  const raw = message.toolResult?.metadata?.memory as Partial<MemoryToolMeta> | undefined;
  if (!raw || typeof raw.opId !== 'number' || typeof raw.batchId !== 'string') return null;
  return raw as MemoryToolMeta;
}

const HEADLINE: Record<MemoryOpKind, string> = {
  add: '已记住',
  update: '已更新记忆',
  delete: '已删除记忆',
};

/**
 * 对话里 agent 写记忆的那一行：用的是工具卡的同一副骨架（`ToolCardFrame`），所以长相、
 * 间距、展开方式和别的工具调用完全一致，连续几次写记忆也和其它工具一样并进同一个分组。
 * 标题行：「已记住」+ 记忆标题 + 作用域小标记；点开看正文，并能「编辑」「撤销」。
 * 撤销后标题划掉并标「已撤销」——而且后台复盘不会再把它加回来（后端记了拒绝）。
 *
 * 失败的调用（标题重复、作用域不可用……）不走这里，退回通用工具卡片显示原因。
 */
function MemoryToolView({ message, grouped }: ToolViewProps) {
  const meta = readMeta(message);
  const success = message.toolResult?.success === true;
  const wrap = grouped ? 'pl-3' : '';
  if (!meta || !success) {
    return (
      <div className={`flex min-w-0 justify-start ${wrap}`}>
        <div className="min-w-0 max-w-[85%]">
          <ToolCallCard message={message} />
        </div>
      </div>
    );
  }
  return (
    <div className={`flex min-w-0 justify-start ${wrap}`}>
      <div className="min-w-0 max-w-[85%]">
        <MemoryCard meta={meta} />
      </div>
    </div>
  );
}

function MemoryCard({ meta }: { meta: MemoryToolMeta }) {
  const mobile = useMemo(() => isMobilePlatform(collectPlatformHints()), []);
  const batch = useMemoryStore((s) => s.batches[meta.batchId]);
  const [expanded, setExpanded] = useMessageViewState('tool-expanded', false);
  const [busy, setBusy] = useState(false);
  const [localReverted, setLocalReverted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<MemoryItem | null>(null);

  useEffect(() => {
    if (!batch) void useMemoryStore.getState().loadBatch(meta.batchId);
  }, [batch, meta.batchId]);

  const rec = batch?.find((o) => o.id === meta.opId);
  const reverted = localReverted || rec?.reverted === true;
  const item = meta.after ?? meta.before;
  const title = item?.title ?? meta.memoryId;

  const undo = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await useMemoryStore.getState().revertOp(meta.opId);
      setLocalReverted(true);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const edit = async () => {
    setError(null);
    await useMemoryStore.getState().loadOverview();
    const current = useMemoryStore.getState().overview?.items.find((m) => m.id === meta.memoryId);
    if (current) setEditing(current);
    else setError('这条记忆已经不在了（被删除或撤销）');
  };

  const btn = `rounded-md text-fg-secondary hover:text-fg hover:bg-state-mid/60 pressable disabled:opacity-40 ${
    mobile ? 'px-2.5 py-1.5 text-meta' : 'px-2 py-0.5 text-caption'
  }`;

  return (
    <>
      <ToolCardFrame
        toolName="memory"
        label={reverted ? '已撤销' : HEADLINE[meta.op]}
        preview={reverted ? <span className="line-through opacity-60">{title}</span> : title}
        chips={
          <ToolChip title={`作用域：${meta.scopeLabel}`} shrinkable className="truncate">
            {meta.scopeLabel}
          </ToolChip>
        }
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
      >
        {expanded && item && (
          <div className="min-w-0 ml-3 border-l border-edge/50 pl-3 pr-1.5 py-1.5">
            <div className="whitespace-pre-wrap break-words text-meta leading-relaxed text-fg-secondary">
              {meta.op === 'update' && meta.before && meta.before.content !== item.content ? (
                <>
                  <span className="text-fg-disabled line-through">{meta.before.content}</span>
                  <br />
                  {item.content}
                </>
              ) : (
                item.content
              )}
            </div>
            {!reverted && (
              <div className="mt-1 -ml-1.5 flex items-center gap-0.5">
                {meta.op !== 'delete' && (
                  <button type="button" className={btn} onClick={() => void edit()}>
                    编辑
                  </button>
                )}
                <button type="button" className={btn} disabled={busy} onClick={() => void undo()}>
                  {busy ? '撤销中…' : '撤销'}
                </button>
              </div>
            )}
            {error && <p className="mt-1 text-meta text-red-400">{error}</p>}
          </div>
        )}
        {expanded && !item && error && <p className="ml-3 pl-3 text-meta text-red-400">{error}</p>}
      </ToolCardFrame>
      <MemoryEditDialog open={!!editing} item={editing} onClose={() => setEditing(null)} />
    </>
  );
}

export default memo(MemoryToolView);
