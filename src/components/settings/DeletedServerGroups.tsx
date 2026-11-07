import { useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft, Trash2 } from 'lucide-react';
import { getErrorMessage } from '@/lib/errors';
import { formatNameWithAddress } from '@/lib/privacy';
import { isDebugConnection } from '@/lib/debugServer';
import { orphanGroupHint, orphanGroupTitle, orphanRetentionNote } from '@/lib/orphanConversations';
import type { OrphanConversationGroup } from '@/lib/types';
import { usePrivacyMode } from '@/hooks/usePrivacyMode';
import { useConnectionStore } from '@/stores/connectionStore';
import { useConversationHistoryStore } from '@/stores/conversationHistoryManager';
import { useSettingsStore } from '@/stores/settingsStore';

type Mode = 'transfer' | 'delete' | null;

/**
 * 聊天历史左栏底部的「已删除的服务器」：删服务器时它的对话被归档留在库里，这里是入口。
 * 点一台展开它的对话（只读，可看可搜）；可以整体转移到另一台现有服务器（比如重新添加了同一台机器），
 * 或彻底删除。确认都在行内展开，不嵌套弹窗。到期清理的天数与归档保留天数共用。
 */
export default function DeletedServerGroups() {
  const privacyMode = usePrivacyMode();
  const connections = useConnectionStore((s) => s.connections);
  const retentionDays = useSettingsStore((s) => s.settings.archiveRetentionDays ?? 30);

  const groups = useConversationHistoryStore((s) => s.orphanGroups);
  const orphanConversations = useConversationHistoryStore((s) => s.orphanConversations);
  const selectedConnId = useConversationHistoryStore((s) => s.selectedConnId);
  const selectedConvId = useConversationHistoryStore((s) => s.selectedConvId);
  const setSelectedConnId = useConversationHistoryStore((s) => s.setSelectedConnId);
  const selectConversation = useConversationHistoryStore((s) => s.selectConversation);
  const loadOrphanConversations = useConversationHistoryStore((s) => s.loadOrphanConversations);
  const reassignOrphan = useConversationHistoryStore((s) => s.reassignOrphan);
  const deleteOrphan = useConversationHistoryStore((s) => s.deleteOrphan);

  const [mode, setMode] = useState<Mode>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedGroupId = groups.find((g) => g.connectionId === selectedConnId)?.connectionId ?? null;

  // 换了选中的分组，上一个分组里没做完的操作作废。
  useEffect(() => {
    setMode(null);
    setTarget(null);
    setError(null);
  }, [selectedConnId]);

  useEffect(() => {
    if (selectedGroupId) void loadOrphanConversations(selectedGroupId);
  }, [selectedGroupId, loadOrphanConversations]);

  const targets = useMemo(
    () => connections.filter((c) => !isDebugConnection(c.id)),
    [connections],
  );

  if (groups.length === 0) return null;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setMode(null);
      setTarget(null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const renderActions = (group: OrphanConversationGroup) => (
    <div className="space-y-2 rounded-lg bg-fill-soft px-2 py-2">
      {mode === null && (
        <div className="flex gap-1.5">
          <button
            type="button"
            disabled={targets.length === 0}
            onClick={() => setMode('transfer')}
            title={targets.length === 0 ? '先添加一台服务器' : undefined}
            className="flex flex-1 items-center justify-center gap-1 rounded-md bg-fill px-2 py-1.5 text-meta text-fg-secondary hover:bg-fill-strong hover:text-fg disabled:opacity-50"
          >
            <ArrowRightLeft size={13} strokeWidth={1.5} />
            转移到其他服务器
          </button>
          <button
            type="button"
            onClick={() => setMode('delete')}
            className="flex items-center justify-center gap-1 rounded-md bg-fill px-2 py-1.5 text-meta text-fg-secondary hover:bg-fill-strong hover:text-red-400"
          >
            <Trash2 size={13} strokeWidth={1.5} />
            彻底删除
          </button>
        </div>
      )}
      {mode === 'transfer' && (
        <div className="space-y-1.5">
          <div className="text-meta text-fg-secondary">
            把这 {group.conversationCount} 条对话转移到：
          </div>
          <div className="max-h-40 space-y-1 overflow-y-auto">
            {targets.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setTarget(c.id)}
                className={`w-full truncate rounded-md px-2 py-1.5 text-left text-meta transition-colors ${
                  target === c.id
                    ? 'bg-indigo-500/15 text-fg'
                    : 'text-fg-secondary hover:bg-fill'
                }`}
              >
                {formatNameWithAddress(c.name, c.host, c.port, privacyMode)}
              </button>
            ))}
          </div>
          <div className="text-caption text-fg-tertiary">
            转移后它们回到那台服务器的普通会话列表，不可再移回。
          </div>
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setMode(null)}
              className="rounded-md px-2 py-1 text-meta text-fg-secondary hover:bg-fill"
            >
              取消
            </button>
            <button
              type="button"
              disabled={!target || busy}
              onClick={() => target && void run(() => reassignOrphan(group.connectionId, target))}
              className="rounded-md bg-indigo-500 px-2.5 py-1 text-meta font-medium text-white hover:bg-indigo-400 disabled:opacity-50"
            >
              {busy ? '转移中…' : '确定转移'}
            </button>
          </div>
        </div>
      )}
      {mode === 'delete' && (
        <div className="space-y-1.5">
          <div className="text-meta text-red-300">
            彻底删除这 {group.conversationCount} 条对话（含图片），无法恢复。
          </div>
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setMode(null)}
              className="rounded-md px-2 py-1 text-meta text-fg-secondary hover:bg-fill"
            >
              取消
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => deleteOrphan(group.connectionId))}
              className="rounded-md bg-red-600 px-2.5 py-1 text-meta font-medium text-white hover:bg-red-500 disabled:opacity-50"
            >
              {busy ? '删除中…' : '确定删除'}
            </button>
          </div>
        </div>
      )}
      {error && (
        <div role="alert" className="text-meta text-red-300">
          {error}
        </div>
      )}
    </div>
  );

  return (
    <div className="mt-3 space-y-1 border-t border-edge-subtle pt-3">
      <div className="px-3">
        <div className="text-meta font-medium text-fg-tertiary">已删除的服务器</div>
        <div className="mt-0.5 text-caption text-fg-disabled">{orphanRetentionNote(retentionDays)}</div>
      </div>
      {groups.map((group) => {
        const isSelected = selectedConnId === group.connectionId;
        const convs = orphanConversations[group.connectionId] ?? [];
        const hint = orphanGroupHint(group);
        return (
          <div key={group.connectionId} className="space-y-1">
            <button
              type="button"
              className={`w-full rounded-lg px-3 py-2 text-left text-body transition-colors ${
                isSelected
                  ? 'bg-state-selected text-fg'
                  : 'text-fg-secondary hover:bg-state-mid hover:text-fg'
              }`}
              onClick={() => setSelectedConnId(isSelected ? null : group.connectionId)}
            >
              <div className="flex items-center justify-between">
                <span className="truncate">{orphanGroupTitle(group, privacyMode)}</span>
                <span className="ml-2 flex-shrink-0 text-meta text-fg-tertiary">
                  {group.conversationCount}
                </span>
              </div>
              {hint && <div className="mt-0.5 truncate text-caption text-fg-tertiary">{hint}</div>}
            </button>
            {isSelected && (
              <div className="space-y-1.5 pl-2">
                {renderActions(group)}
                {convs.map((conv) => (
                  <button
                    key={conv.id}
                    type="button"
                    className={`w-full rounded-lg px-2 py-2 text-left text-body transition-colors ${
                      selectedConvId === conv.id
                        ? 'bg-state-selected text-fg ring-1 ring-edge-strong'
                        : 'text-fg-secondary hover:bg-state-mid/60 hover:text-fg'
                    }`}
                    onClick={() =>
                      void selectConversation(conv.id === selectedConvId ? null : conv, group.connectionId)
                    }
                  >
                    <div className="truncate font-medium">{conv.title}</div>
                    <div className="mt-1 text-caption text-fg-tertiary">
                      {new Date(conv.updatedAt).toLocaleString()}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
