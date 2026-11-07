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
import MobileSheet from './ui/MobileSheet';

/**
 * 手机聊天历史底部的「已删除的服务器」，与桌面 `DeletedServerGroups` 对齐：
 * 点一台展开它的对话（只读），可整体转移到另一台现有服务器，或彻底删除。
 * 转移 / 删除的确认走底部抽屉，与本页其它确认一致。
 */
export default function MobileDeletedServerGroups({
  expandedId,
  onExpandedChange,
}: {
  /** 展开的是哪一台。放在父组件里：点开一条对话再返回，列表会重新挂载，状态不能丢。 */
  expandedId: string | null;
  onExpandedChange: (id: string | null) => void;
}) {
  const privacyMode = usePrivacyMode();
  const connections = useConnectionStore((s) => s.connections);
  const retentionDays = useSettingsStore((s) => s.settings.archiveRetentionDays ?? 30);

  const groups = useConversationHistoryStore((s) => s.orphanGroups);
  const orphanConversations = useConversationHistoryStore((s) => s.orphanConversations);
  const selectConversation = useConversationHistoryStore((s) => s.selectConversation);
  const loadOrphanConversations = useConversationHistoryStore((s) => s.loadOrphanConversations);
  const reassignOrphan = useConversationHistoryStore((s) => s.reassignOrphan);
  const deleteOrphan = useConversationHistoryStore((s) => s.deleteOrphan);

  const [transferFrom, setTransferFrom] = useState<OrphanConversationGroup | null>(null);
  const [transferTarget, setTransferTarget] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<OrphanConversationGroup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targets = useMemo(
    () => connections.filter((c) => !isDebugConnection(c.id)),
    [connections],
  );

  useEffect(() => {
    if (expandedId) void loadOrphanConversations(expandedId);
  }, [expandedId, loadOrphanConversations]);

  // 展开的那台被转移走 / 删光之后，分组没了，展开状态跟着清。
  useEffect(() => {
    if (expandedId && !groups.some((g) => g.connectionId === expandedId)) onExpandedChange(null);
  }, [groups, expandedId, onExpandedChange]);

  if (groups.length === 0) return null;

  const closeSheets = () => {
    setTransferFrom(null);
    setTransferTarget(null);
    setDeleteTarget(null);
    setError(null);
  };

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      closeSheets();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 space-y-1 border-t border-edge-subtle pt-3">
      <div className="px-3">
        <div className="text-meta font-medium text-fg-tertiary">已删除的服务器</div>
        <div className="mt-0.5 text-caption text-fg-disabled">{orphanRetentionNote(retentionDays)}</div>
      </div>
      {groups.map((group) => {
        const expanded = expandedId === group.connectionId;
        const convs = orphanConversations[group.connectionId] ?? [];
        const hint = orphanGroupHint(group);
        return (
          <div key={group.connectionId} className="mb-1">
            <button
              type="button"
              onClick={() => onExpandedChange(expanded ? null : group.connectionId)}
              className={`w-full rounded-lg px-3 py-2.5 text-left text-body ${
                expanded
                  ? 'bg-fill text-fg'
                  : 'bg-surface-raised/60 text-fg-secondary active:bg-state-soft'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">{orphanGroupTitle(group, privacyMode)}</span>
                <span className="flex-shrink-0 text-meta text-fg-tertiary">
                  {group.conversationCount}
                </span>
              </div>
              {hint && <div className="mt-0.5 truncate text-caption text-fg-tertiary">{hint}</div>}
            </button>
            {expanded && (
              <div className="mt-1 space-y-1.5 pl-2">
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={targets.length === 0}
                    onClick={() => setTransferFrom(group)}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-fill px-3 py-2 text-body text-fg-secondary active:bg-state-mid disabled:opacity-50"
                  >
                    <ArrowRightLeft className="h-3.5 w-3.5" />
                    转移到其他服务器
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteTarget(group)}
                    className="flex items-center justify-center gap-1.5 rounded-lg bg-fill px-3 py-2 text-body text-red-400/90 active:bg-state-mid"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    彻底删除
                  </button>
                </div>
                <ul className="space-y-1">
                  {convs.map((conv) => (
                    <li key={conv.id} className="rounded-lg bg-surface-raised/40">
                      <button
                        type="button"
                        onClick={() => void selectConversation(conv)}
                        className="w-full rounded-lg px-3 py-2.5 text-left text-body text-fg-secondary active:bg-state-soft"
                      >
                        <div className="truncate font-medium">{conv.title}</div>
                        <div className="mt-0.5 text-caption text-fg-tertiary">
                          {new Date(conv.updatedAt).toLocaleString()}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        );
      })}

      <MobileSheet open={transferFrom != null} onClose={closeSheets} title="转移到其他服务器">
        <div className="flex flex-col gap-3 px-4 pb-4">
          <p className="text-body leading-relaxed text-fg-secondary">
            把这 {transferFrom?.conversationCount ?? 0} 条对话转移到下面的服务器，
            它们会回到那台服务器的普通会话列表，不可再移回。
          </p>
          <ul className="max-h-[40dvh] space-y-1 overflow-y-auto">
            {targets.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setTransferTarget(c.id)}
                  className={`w-full truncate rounded-lg px-3 py-2.5 text-left text-body ${
                    transferTarget === c.id
                      ? 'bg-indigo-500/15 text-fg'
                      : 'bg-surface-raised/60 text-fg-secondary active:bg-state-soft'
                  }`}
                >
                  {formatNameWithAddress(c.name, c.host, c.port, privacyMode)}
                </button>
              </li>
            ))}
          </ul>
          {error && (
            <div
              role="alert"
              className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-meta text-red-300"
            >
              {error}
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!transferTarget || busy}
              onClick={() =>
                transferFrom &&
                transferTarget &&
                void run(() => reassignOrphan(transferFrom.connectionId, transferTarget))
              }
              className="flex-1 rounded-xl bg-indigo-500 px-4 py-2.5 text-body font-medium text-white active:bg-indigo-400 disabled:opacity-50"
            >
              {busy ? '转移中…' : '确定转移'}
            </button>
            <button
              type="button"
              onClick={closeSheets}
              className="flex-1 rounded-xl bg-fill px-4 py-2.5 text-body font-medium text-fg-secondary active:bg-state-mid"
            >
              取消
            </button>
          </div>
        </div>
      </MobileSheet>

      <MobileSheet open={deleteTarget != null} onClose={closeSheets} title="彻底删除对话">
        <div className="flex flex-col gap-3 px-4 pb-4">
          <p className="text-body leading-relaxed text-fg-secondary">
            彻底删除「{deleteTarget ? orphanGroupTitle(deleteTarget, privacyMode) : ''}」的
            {deleteTarget?.conversationCount ?? 0} 条对话（含图片）？此操作不可撤销。
          </p>
          {error && (
            <div
              role="alert"
              className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-meta text-red-300"
            >
              {error}
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => deleteTarget && void run(() => deleteOrphan(deleteTarget.connectionId))}
              className="flex-1 rounded-xl bg-red-600 px-4 py-2.5 text-body font-medium text-white active:bg-red-500 disabled:opacity-50"
            >
              {busy ? '删除中…' : '彻底删除'}
            </button>
            <button
              type="button"
              onClick={closeSheets}
              className="flex-1 rounded-xl bg-fill px-4 py-2.5 text-body font-medium text-fg-secondary active:bg-state-mid"
            >
              取消
            </button>
          </div>
        </div>
      </MobileSheet>
    </div>
  );
}
