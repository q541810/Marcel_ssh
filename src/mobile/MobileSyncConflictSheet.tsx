/**
 * 同步冲突解决 Sheet（移动端）。
 *
 * 触发场景：syncStore 收到 sync-conflicts-detected 事件后 conflictModalOpen=true。
 * 行为：
 * - 顶部批量操作（冲突 ≥ 2 时显示）
 * - 中间滚动列表显示单条冲突
 * - 底部"稍后处理"按钮 = 推迟（关闭 Sheet，pendingConflicts 保留）
 * - 下拉/点击背景也可关闭（=推迟）
 *
 * 单条决策同桌面端：用本地 / 用云端 / 跳过本次 / 永久跳过
 * 会话冲突额外显示：开 Fork（独占一行，保留本地原会话 + 远程内容另存为新会话）
 */

import { useMemo, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Ban, Clock, GitFork, Layers } from 'lucide-react';
import MobileSheet from './ui/MobileSheet';
import { useSyncStore } from '@/stores/syncStore';
import type { SyncConflictAction, SyncPendingConflict } from '@/lib/types';

/** 把 JSON 字符串格式化为可读的多行字符串 */
function formatValue(value: string | null): string {
  if (value === null || value === '') return '（空 / 删除）';
  try {
    const parsed = JSON.parse(value);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return value;
  }
}

/** 从 key 提取可读标签 */
function keyLabel(key: string): string {
  if (key.startsWith('settings.')) return key.substring('settings.'.length);
  if (key.startsWith('connections.')) return `连接 ${key.substring('connections.'.length).slice(0, 8)}`;
  if (key.startsWith('quickCommands.')) return `快捷命令 ${key.substring('quickCommands.'.length).slice(0, 8)}`;
  if (key.startsWith('skills.')) return `技能 ${key.substring('skills.'.length).slice(0, 8)}`;
  if (key.startsWith('mcpServers.')) return `MCP ${key.substring('mcpServers.'.length).slice(0, 8)}`;
  if (key.startsWith('conversations.')) return `会话 ${key.substring('conversations.'.length).slice(0, 8)}`;
  if (key === 'secrets.llmApiKey') return 'LLM API Key';
  return key;
}

export default function MobileSyncConflictSheet() {
  const {
    pendingConflicts,
    conflictModalOpen,
    closeConflictModal,
    resolveConflict,
    resolveAllConflicts,
  } = useSyncStore();

  const [resolvingKey, setResolvingKey] = useState<string | null>(null);

  const handleResolve = async (key: string, action: SyncConflictAction) => {
    setResolvingKey(key);
    try {
      await resolveConflict(key, action);
    } finally {
      setResolvingKey(null);
    }
  };

  const handleBatch = async (actionType: SyncConflictAction['type']) => {
    const actions: Record<string, SyncConflictAction> = {};
    for (const c of pendingConflicts) {
      if (actionType === 'ours') {
        actions[c.key] = { type: 'ours' };
      } else if (actionType === 'theirs') {
        actions[c.key] = { type: 'theirs' };
      } else if (actionType === 'skipOnce') {
        actions[c.key] = { type: 'skipOnce' };
      } else if (actionType === 'skipForever') {
        actions[c.key] = { type: 'skipForever' };
      }
    }
    setResolvingKey('__batch__');
    try {
      await resolveAllConflicts(actions);
    } finally {
      setResolvingKey(null);
    }
  };

  // 移动端把 4 个批量操作横向滚动排列（屏幕窄）
  const batchRow = useMemo(() => {
    if (pendingConflicts.length < 2) return null;
    const btnClass =
      'flex-shrink-0 text-xs px-3 py-1.5 rounded-full active:opacity-80 disabled:opacity-50';
    return (
      <div className="flex items-center gap-2 overflow-x-auto px-4 py-2 border-b border-zinc-800">
        <span className="flex-shrink-0 text-xs text-zinc-500">批量</span>
        <button
          onClick={() => handleBatch('ours')}
          disabled={resolvingKey !== null}
          className={`${btnClass} bg-green-600 text-white`}
        >
          全本地
        </button>
        <button
          onClick={() => handleBatch('theirs')}
          disabled={resolvingKey !== null}
          className={`${btnClass} bg-emerald-600 text-white`}
        >
          全云端
        </button>
        <button
          onClick={() => handleBatch('skipOnce')}
          disabled={resolvingKey !== null}
          className={`${btnClass} bg-zinc-700 text-zinc-100`}
        >
          全跳过
        </button>
        <button
          onClick={() => handleBatch('skipForever')}
          disabled={resolvingKey !== null}
          className={`${btnClass} bg-zinc-700 text-zinc-100`}
        >
          全永久跳过
        </button>
      </div>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingConflicts.length, resolvingKey]);

  return (
    <MobileSheet
      open={conflictModalOpen}
      onClose={closeConflictModal}
      dismissible={true}
      title={
        <span className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-amber-400" />
          同步冲突（{pendingConflicts.length} 项）
        </span>
      }
      footer={
        <button
          type="button"
          onClick={closeConflictModal}
          className="w-full rounded-xl bg-zinc-800 px-4 py-3 text-sm font-medium text-zinc-200 active:bg-zinc-700"
        >
          稍后处理
        </button>
      }
    >
      {batchRow}

      <div className="space-y-3 px-4 py-3">
        {pendingConflicts.length === 0 && (
          <div className="py-8 text-center text-zinc-400">
            <p className="text-sm">没有待解决的冲突</p>
          </div>
        )}

        {pendingConflicts.map((c) => (
          <ConflictItem
            key={c.key}
            conflict={c}
            resolving={resolvingKey === c.key}
            onResolve={handleResolve}
          />
        ))}
      </div>
    </MobileSheet>
  );
}

interface ConflictItemProps {
  conflict: SyncPendingConflict;
  resolving: boolean;
  onResolve: (key: string, action: SyncConflictAction) => Promise<void>;
}

function ConflictItem({ conflict, resolving, onResolve }: ConflictItemProps) {
  const label = keyLabel(conflict.key);
  const oursDisplay = formatValue(conflict.ours);
  const theirsDisplay = formatValue(conflict.theirs);
  // Fork 仅对会话冲突有意义：保留本地原会话，远程内容另存为新会话
  const canFork = conflict.key.startsWith('conversations.');

  const btnClass =
    'flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-2 text-xs transition-colors active:opacity-80 disabled:opacity-50';

  return (
    <div className="rounded-xl border border-zinc-700 bg-zinc-800/40 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="truncate font-mono text-sm text-zinc-100">{label}</span>
        <span className="flex-shrink-0 text-xs text-zinc-500">v{conflict.remoteVersion}</span>
      </div>

      <div className="mb-3 space-y-2">
        <div className="rounded-lg bg-zinc-950/60 p-2 border border-zinc-700">
          <div className="mb-1 flex items-center gap-1 text-xs text-green-300">
            <ArrowDownToLine className="w-3 h-3" />
            本地值
          </div>
          <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-all font-mono text-xs text-zinc-200">
            {oursDisplay}
          </pre>
        </div>
        <div className="rounded-lg bg-zinc-950/60 p-2 border border-zinc-700">
          <div className="mb-1 flex items-center gap-1 text-xs text-emerald-300">
            <ArrowUpFromLine className="w-3 h-3" />
            云端值
          </div>
          <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-all font-mono text-xs text-zinc-200">
            {theirsDisplay}
          </pre>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <button
          onClick={() => onResolve(conflict.key, { type: 'ours' })}
          disabled={resolving}
          className={`${btnClass} bg-green-600 text-white`}
        >
          <ArrowDownToLine className="w-3 h-3" />
          用本地
        </button>
        <button
          onClick={() => onResolve(conflict.key, { type: 'theirs' })}
          disabled={resolving}
          className={`${btnClass} bg-emerald-600 text-white`}
        >
          <ArrowUpFromLine className="w-3 h-3" />
          用云端
        </button>
        <button
          onClick={() => onResolve(conflict.key, { type: 'skipOnce' })}
          disabled={resolving}
          className={`${btnClass} bg-zinc-700 text-zinc-100`}
        >
          <Clock className="w-3 h-3" />
          跳过本次
        </button>
        <button
          onClick={() => onResolve(conflict.key, { type: 'skipForever' })}
          disabled={resolving}
          className={`${btnClass} bg-zinc-700 text-zinc-100`}
          title="加入永久跳过清单，本字段不再同步"
        >
          <Ban className="w-3 h-3" />
          永久跳过
        </button>
        {canFork && (
          <button
            onClick={() => onResolve(conflict.key, { type: 'fork' })}
            disabled={resolving}
            className={`${btnClass} col-span-2 bg-amber-600 text-white`}
            title="保留本地原会话，云端内容另存为新会话（两端都不丢）"
          >
            <GitFork className="w-3 h-3" />
            开 Fork（保留双方）
          </button>
        )}
      </div>
    </div>
  );
}
