/**
 * 同步冲突解决 Modal（桌面端）。
 *
 * 触发场景：
 * - pull 后检测到字段级冲突（本地和远程都改了同一 key 且值不同）
 * - syncStore 收到 sync-conflicts-detected 事件后自动打开
 *
 * 单条决策选项：
 * - 用本地值（ours）→ bump 版本号触发 push，让远程更新
 * - 用远程值（theirs）→ apply theirs，不 push
 * - 开 Fork（仅 conversations.*）→ 保留本地原会话，远程内容另存为新会话
 * - 跳过本次（skipOnce）→ 不 apply，下次 pull 还会冲突
 * - 永久跳过（skipForever）→ 加入 excluded_keys + 持久化 SyncProfile
 *
 * 批量操作：
 * - 全部用本地 / 全部用远程 / 全部跳过 / 全部永久跳过
 * （Fork 不参与批量操作，因为它只对会话有意义，且语义上不应一键应用）
 */

import { useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Ban, Check, Clock, GitFork, Layers } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { useSyncStore } from '@/stores/syncStore';
import type { SyncConflictAction, SyncPendingConflict } from '@/lib/types';

/** 把 JSON 字符串格式化为可读的多行字符串（用于展示 ours/theirs/base） */
function formatValue(value: string | null): string {
  if (value === null || value === '') return '（空 / 删除）';
  try {
    const parsed = JSON.parse(value);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return value;
  }
}

/** 从 key 提取可读的标签（如 settings.fontSize → 字体大小） */
function keyLabel(key: string): string {
  // settings.{field} 或 settings.{group}.{field}
  if (key.startsWith('settings.')) {
    return key.substring('settings.'.length);
  }
  if (key.startsWith('connections.')) return `连接 ${key.substring('connections.'.length).slice(0, 8)}`;
  if (key.startsWith('quickCommands.')) return `快捷命令 ${key.substring('quickCommands.'.length).slice(0, 8)}`;
  if (key.startsWith('skills.')) return `技能 ${key.substring('skills.'.length).slice(0, 8)}`;
  if (key.startsWith('mcpServers.')) return `MCP ${key.substring('mcpServers.'.length).slice(0, 8)}`;
  if (key.startsWith('conversations.')) return `会话 ${key.substring('conversations.'.length).slice(0, 8)}`;
  if (key === 'secrets.llmApiKey') return 'LLM API Key';
  return key;
}

export default function SyncConflictModal() {
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

  const batchButtons = useMemo(() => {
    if (pendingConflicts.length < 2) return null;
    return (
      <div className="flex items-center gap-2 px-4 py-2 border-b border-zinc-700 bg-zinc-900/50">
        <span className="text-xs text-zinc-400">批量操作：</span>
        <button
          onClick={() => handleBatch('ours')}
          disabled={resolvingKey !== null}
          className="text-xs px-2 py-1 rounded bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 text-zinc-100"
        >
          全部用本地
        </button>
        <button
          onClick={() => handleBatch('theirs')}
          disabled={resolvingKey !== null}
          className="text-xs px-2 py-1 rounded bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 text-zinc-100"
        >
          全部用云端
        </button>
        <button
          onClick={() => handleBatch('skipOnce')}
          disabled={resolvingKey !== null}
          className="text-xs px-2 py-1 rounded bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 text-zinc-100"
        >
          全部跳过本次
        </button>
        <button
          onClick={() => handleBatch('skipForever')}
          disabled={resolvingKey !== null}
          className="text-xs px-2 py-1 rounded bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 text-zinc-100"
        >
          全部永久跳过
        </button>
      </div>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingConflicts.length, resolvingKey]);

  return (
    <Modal
      open={conflictModalOpen}
      onClose={closeConflictModal}
      title={`同步冲突（${pendingConflicts.length} 项待解决）`}
      size="lg"
    >
      {batchButtons}

      <div className="overflow-y-auto max-h-[60vh] px-4 py-3 space-y-3">
        {pendingConflicts.length === 0 && (
          <div className="text-center py-8 text-zinc-400">
            <Check className="w-8 h-8 mx-auto mb-2 text-emerald-400" />
            <p>没有待解决的冲突</p>
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

      <div className="flex items-center justify-between px-4 py-3 border-t border-zinc-700">
        <span className="text-xs text-zinc-500">
          <Clock className="inline w-3 h-3 mr-1" />
          推迟：关闭窗口即可推迟处理，下次 pull 还会提示
        </span>
        <button
          onClick={closeConflictModal}
          className="px-3 py-1.5 text-sm rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-100"
        >
          稍后处理
        </button>
      </div>
    </Modal>
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
    'flex items-center gap-1 px-2.5 py-1 rounded text-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900/50 p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-amber-400" />
          <span className="text-sm font-mono text-zinc-100">{label}</span>
        </div>
        <span className="text-xs text-zinc-500">远程版本 v{conflict.remoteVersion}</span>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="rounded bg-zinc-800/80 p-2 border border-zinc-700">
          <div className="text-xs text-green-300 mb-1 flex items-center gap-1">
            <ArrowLeft className="w-3 h-3" />
            本地值
          </div>
          <pre className="text-xs text-zinc-200 font-mono whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
            {oursDisplay}
          </pre>
        </div>
        <div className="rounded bg-zinc-800/80 p-2 border border-zinc-700">
          <div className="text-xs text-emerald-300 mb-1 flex items-center gap-1">
            <ArrowRight className="w-3 h-3" />
            云端值
          </div>
          <pre className="text-xs text-zinc-200 font-mono whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
            {theirsDisplay}
          </pre>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={() => onResolve(conflict.key, { type: 'ours' })}
          disabled={resolving}
          className={`${btnClass} bg-green-600 hover:bg-green-500 text-white`}
        >
          <ArrowLeft className="w-3 h-3" />
          用本地
        </button>
        <button
          onClick={() => onResolve(conflict.key, { type: 'theirs' })}
          disabled={resolving}
          className={`${btnClass} bg-emerald-600 hover:bg-emerald-500 text-white`}
        >
          <ArrowRight className="w-3 h-3" />
          用云端
        </button>
        {canFork && (
          <button
            onClick={() => onResolve(conflict.key, { type: 'fork' })}
            disabled={resolving}
            className={`${btnClass} bg-amber-600 hover:bg-amber-500 text-white`}
            title="保留本地原会话，云端内容另存为新会话（两端都不丢）"
          >
            <GitFork className="w-3 h-3" />
            开 Fork
          </button>
        )}
        <button
          onClick={() => onResolve(conflict.key, { type: 'skipOnce' })}
          disabled={resolving}
          className={`${btnClass} bg-zinc-700 hover:bg-zinc-600 text-zinc-100`}
        >
          <Clock className="w-3 h-3" />
          跳过本次
        </button>
        <button
          onClick={() => onResolve(conflict.key, { type: 'skipForever' })}
          disabled={resolving}
          className={`${btnClass} bg-zinc-700 hover:bg-zinc-600 text-zinc-100`}
          title="加入永久跳过清单，本字段不再同步"
        >
          <Ban className="w-3 h-3" />
          永久跳过
        </button>
      </div>
    </div>
  );
}
