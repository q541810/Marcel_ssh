import { useCallback, useEffect, useMemo, useState } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import type {
  AgentConversation,
  AgentMessage as AgentMessageType,
  ConversationSearchResult,
  SavedConnection,
} from '@/lib/types';
import { useConnectionStore } from '@/stores/connectionStore';
import { useTaskStore } from '@/stores/taskStore';
import { getConversationAgentStatus } from '@/stores/agentStatusSelectors';
import { AgentStatusIndicator } from '@/components/agent/AgentStatusIndicator';
import { ForkMark } from '@/components/agent/ForkMark';
import { usePrivacyMode } from '@/hooks/usePrivacyMode';
import { formatNameWithAddress } from '@/lib/privacy';
import { groupConversationsWithPinned } from '@/lib/dateGrouping';
import {
  useConversationHistoryStore,
  groupSearchResultsByConnection,
  formatMatchCountLabel,
} from '@/stores/conversationHistoryManager';
import { Archive, ArchiveRestore, Pencil, Pin, Trash2 } from 'lucide-react';
import { getErrorMessage } from '@/lib/errors';
import { useConversationStore } from '@/stores/conversationStore';
import AgentMessageList from '@/components/agent/AgentMessageList';
import { MOBILE_MAX_RETAINED_VIEWS } from '@/lib/retainedViews';
import MobileSheet from './ui/MobileSheet';

interface MobileChatHistorySheetProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 移动端聊天历史浏览面板（只读）。
 *
 * 与桌面 ChatHistoryModal 对齐：通过 conversationHistoryManager 统一管理历史数据、
 * 搜索、高亮导航与重命名。
 */
export default function MobileChatHistorySheet({
  open,
  onClose,
}: MobileChatHistorySheetProps) {
  const connections = useConnectionStore((s) => s.connections);
  const connectionsLoading = useConnectionStore((s) => s.loading);
  const fetchConnections = useConnectionStore((s) => s.fetchConnections);
  const tasks = useTaskStore((s) => s.tasks);
  const unreadCompletedConversations = useTaskStore(
    (s) => s.unreadCompletedConversations,
  );
  const privacyMode = usePrivacyMode();
  const connLabel = useCallback(
    (c: SavedConnection) => formatNameWithAddress(c.name, c.host, c.port, privacyMode),
    [privacyMode],
  );

  const [expandedConnId, setExpandedConnId] = useState<string | null>(null);

  // 从 manager 中订阅状态
  const conversationsByConn = useConversationHistoryStore((s) => s.conversationsByConn);
  const loadingConvs = useConversationHistoryStore((s) => s.loadingConvs);
  const selectedConv = useConversationHistoryStore((s) => s.selectedConv);
  const selectedConvId = useConversationHistoryStore((s) => s.selectedConvId);
  const messages = useConversationHistoryStore((s) => s.messages);
  const loadingMsgs = useConversationHistoryStore((s) => s.loadingMsgs);

  const searchInput = useConversationHistoryStore((s) => s.searchInput);
  const debouncedQuery = useConversationHistoryStore((s) => s.debouncedQuery);
  const searchResults = useConversationHistoryStore((s) => s.searchResults);
  const loadingSearch = useConversationHistoryStore((s) => s.loadingSearch);

  const activeMatchIds = useConversationHistoryStore((s) => s.activeMatchIds);
  const matchIndex = useConversationHistoryStore((s) => s.matchIndex);
  const highlightMessageId = useConversationHistoryStore((s) => s.highlightMessageId);

  const setConversationPinned = useConversationHistoryStore((s) => s.setConversationPinned);
  const renameTarget = useConversationHistoryStore((s) => s.renameTarget);
  const renameInput = useConversationHistoryStore((s) => s.renameInput);

  // manager actions
  const loadAllConnections = useConversationHistoryStore((s) => s.loadAllConnections);
  const selectConversation = useConversationHistoryStore((s) => s.selectConversation);
  const openSearchResult = useConversationHistoryStore((s) => s.openSearchResult);
  const clearSelectedConversation = useConversationHistoryStore((s) => s.clearSelectedConversation);
  const setSearchInput = useConversationHistoryStore((s) => s.setSearchInput);
  const clearSearch = useConversationHistoryStore((s) => s.clearSearch);
  const goMatch = useConversationHistoryStore((s) => s.goMatch);
  const startRename = useConversationHistoryStore((s) => s.startRename);
  const setRenameInput = useConversationHistoryStore((s) => s.setRenameInput);
  const cancelRename = useConversationHistoryStore((s) => s.cancelRename);
  const confirmRename = useConversationHistoryStore((s) => s.confirmRename);
  const reset = useConversationHistoryStore((s) => s.reset);

  // 归档 / 恢复 / 永久删除（与桌面 ChatHistoryModal 同一套 manager 动作）
  const showArchived = useConversationHistoryStore((s) => s.showArchived);
  const setShowArchived = useConversationHistoryStore((s) => s.setShowArchived);
  const archiveConversation = useConversationHistoryStore((s) => s.archiveConversation);
  const unarchiveConversation = useConversationHistoryStore((s) => s.unarchiveConversation);
  const deleteArchivedConversation = useConversationHistoryStore(
    (s) => s.deleteArchivedConversation,
  );
  const archivedByConn = useConversationStore((s) => s.archivedConversations);
  const loadArchivedConversations = useConversationStore(
    (s) => s.loadArchivedConversations,
  );
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentConversation | null>(null);

  const isSearching = debouncedQuery.trim().length > 0;

  // 打开/关闭时重置与加载状态
  useEffect(() => {
    if (!open) {
      setExpandedConnId(null);
      reset();
    } else {
      void fetchConnections();
    }
  }, [open, fetchConnections, reset]);

  // 按连接维度加载所有历史会话
  useEffect(() => {
    if (!open) return;
    if (connections.length > 0) {
      void loadAllConnections(connections);
    }
  }, [open, connections, loadAllConnections]);

  // 打开「显示已归档」时补拉各连接的归档缓存（手机上只在这里用到它）
  useEffect(() => {
    if (!open || !showArchived) return;
    for (const conn of connections) {
      void loadArchivedConversations(conn.id);
    }
  }, [open, showArchived, connections, loadArchivedConversations]);

  const handleArchive = async (conversationId: string) => {
    setArchiveError(null);
    try {
      await archiveConversation(conversationId);
    } catch (err) {
      setArchiveError(getErrorMessage(err));
    }
  };

  const handleRestoreArchived = async (conv: AgentConversation) => {
    setArchiveError(null);
    try {
      await unarchiveConversation(conv.id, conv.connectionId);
      // 恢复后归档缓存里已没有它，但当前展开的分组要立刻消失：
      // manager 与 conversationStore 各自更新，这里只需重新拉一次确认。
      await loadArchivedConversations(conv.connectionId);
    } catch (err) {
      setArchiveError(getErrorMessage(err));
    }
  };

  const handleDeleteArchived = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setArchiveError(null);
    try {
      await deleteArchivedConversation(target.id);
      setDeleteTarget(null);
    } catch (err) {
      setArchiveError(getErrorMessage(err));
    }
  };

  const handleStartRename = (e: React.MouseEvent, conv: AgentConversation) => {
    e.stopPropagation();
    startRename(conv);
  };

  const handleConfirmRename = async () => {
    await confirmRename();
  };

  const connNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of connections) m.set(c.id, connLabel(c));
    return m;
  }, [connections, connLabel]);

  const groupedSearch = useMemo(() => {
    return groupSearchResultsByConnection(searchResults, connNameById);
  }, [searchResults, connNameById]);

  const openConversation = useCallback(
    (conv: AgentConversation) => {
      void selectConversation(conv);
    },
    [selectConversation],
  );

  const handleOpenSearchResult = useCallback(
    (r: ConversationSearchResult) => {
      void openSearchResult(r);
    },
    [openSearchResult],
  );

  const handleBack = useCallback(() => {
    clearSelectedConversation();
  }, [clearSelectedConversation]);

  const handleCopyMessage = useCallback(async (m: AgentMessageType) => {
    try {
      await writeText(m.content);
    } catch (err) {
      console.error('Failed to copy message:', err);
    }
  }, []);

  const handleCopyText = useCallback(async (text: string) => {
    await writeText(text);
  }, []);

  return (
    <MobileSheet
      open={open}
      onClose={onClose}
      maxHeightClassName="h-[85dvh] max-h-[85dvh]"
      title={
        selectedConv ? (
          <div className="flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              onClick={handleBack}
              className="-ml-1 flex-shrink-0 rounded-lg px-2 py-1 text-xs text-indigo-300 active:bg-state-soft"
            >
              ‹ 返回
            </button>
            <span className="min-w-0 truncate">{selectedConv.title}</span>
          </div>
        ) : (
          '聊天历史记录'
        )
      }
    >
      {selectedConv ? (
        <div className="flex flex-col">
          {activeMatchIds.length > 0 && (
            <div className="sticky top-0 z-10 flex flex-shrink-0 items-center justify-between gap-2 border-b border-indigo-500/15 bg-zinc-900/95 px-4 py-1.5 text-xs backdrop-blur-sm">
              <span className="text-indigo-300/90">
                匹配 {matchIndex + 1}/{activeMatchIds.length}
                {activeMatchIds.length >= 200 ? '+' : ''}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={matchIndex <= 0}
                  onClick={() => goMatch(-1)}
                  className="rounded-lg bg-zinc-800 px-3.5 py-1 text-sm text-zinc-200 active:bg-state-mid disabled:opacity-30"
                  aria-label="上一条匹配"
                >
                  ▲
                </button>
                <button
                  type="button"
                  disabled={matchIndex >= activeMatchIds.length - 1}
                  onClick={() => goMatch(1)}
                  className="rounded-lg bg-zinc-800 px-3.5 py-1 text-sm text-zinc-200 active:bg-state-mid disabled:opacity-30"
                  aria-label="下一条匹配"
                >
                  ▼
                </button>
              </div>
            </div>
          )}
          <div className="truncate px-4 pb-1 pt-2 text-[11px] text-zinc-500">
            {connNameById.get(selectedConv.connectionId) ??
              selectedConv.connectionId}
            {' · '}
            {new Date(selectedConv.updatedAt).toLocaleString()}
          </div>
          <div className="px-3 pb-3">
            {loadingMsgs && (
              <p className="py-8 text-center text-sm text-zinc-500">
                加载消息…
              </p>
            )}
            {!loadingMsgs && messages.length === 0 && (
              <p className="py-8 text-center text-sm text-zinc-500">
                该会话暂无消息
              </p>
            )}
            {!loadingMsgs && messages.length > 0 && (
              <AgentMessageList
                messages={messages}
                // 只读浏览：撤回入口一律禁用
                rollbackDisabled
                // 历史只读/检索视图：永不折叠回合（用户可能在翻找/搜索定位）
                conversationId={selectedConvId ?? undefined}
                foldTurns={false}
                onCopy={(m) => void handleCopyMessage(m)}
                onCopyText={handleCopyText}
                highlightMessageId={highlightMessageId}
                matchedMessageIds={activeMatchIds}
                searchKeyword={
                  isSearching ? debouncedQuery.trim() : undefined
                }
                alwaysShowActions
                maxRetainedViews={MOBILE_MAX_RETAINED_VIEWS}
              />
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-col">
          <div className="sticky top-0 z-10 bg-zinc-900 px-4 pb-2 pt-1">
            <div className="relative">
              <svg
                className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-4.35-4.35M11 18a7 7 0 100-14 7 7 0 000 14z"
                />
              </svg>
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="搜索聊天记录…"
                className="w-full rounded-lg border border-edge bg-zinc-800 py-2 pl-9 pr-9 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-500 focus:outline-none"
              />
              {searchInput && (
                <button
                  type="button"
                  onClick={clearSearch}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1.5 text-zinc-500 active:text-zinc-200"
                  aria-label="清除搜索"
                >
                  <svg
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              )}
            </div>
            <div className="mt-1.5 flex items-center justify-between px-0.5">
              <button
                type="button"
                onClick={() => setShowArchived(!showArchived)}
                aria-pressed={showArchived}
                className={
                  "flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] " +
                  (showArchived
                    ? "border-amber-700/60 bg-amber-950/40 text-amber-300"
                    : "border-edge bg-zinc-800/60 text-zinc-400")
                }
              >
                <Archive className="h-3 w-3" />
                显示已归档
              </button>
              <span className="text-[10px] text-zinc-600">
                {showArchived ? '搜索与列表均包含归档' : '归档可在清理前恢复'}
              </span>
            </div>
          </div>

          <div className="px-3 pb-3">
            {archiveError && (
              <div
                role="alert"
                className="mb-2 rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-xs text-red-300"
              >
                {archiveError}
              </div>
            )}
            {isSearching ? (
              <>
                {loadingSearch && (
                  <p className="py-8 text-center text-sm text-zinc-500">
                    搜索中…
                  </p>
                )}
                {!loadingSearch && searchResults.length === 0 && (
                  <p className="py-8 text-center text-sm text-zinc-500">
                    没有找到匹配的聊天记录
                  </p>
                )}
                {!loadingSearch &&
                  groupedSearch.map((group) => (
                    <div key={group.connectionId} className="mb-2">
                      <div className="truncate px-3 py-1 text-xs font-medium text-zinc-500">
                        {group.label}
                      </div>
                      <ul className="space-y-1">
                        {group.items.map((r) => (
                          <li key={r.conversationId}>
                            <button
                              type="button"
                              onClick={() => handleOpenSearchResult(r)}
                              className="w-full rounded-lg bg-zinc-800/60 px-3 py-2.5 text-left text-sm text-zinc-300 active:bg-state-soft"
                            >
                              <div className="truncate font-medium">
                                {r.title}
                              </div>
                              <div className="mt-0.5 line-clamp-2 break-words text-xs text-zinc-500">
                                {r.matchedSnippet}
                              </div>
                              <div className="mt-0.5 text-xs text-indigo-400/80">
                                {formatMatchCountLabel(r.matchCount)}
                              </div>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
              </>
            ) : (
              <>
                {(loadingConvs || connectionsLoading) && (
                  <p className="py-8 text-center text-sm text-zinc-500">
                    加载中…
                  </p>
                )}
                {!loadingConvs &&
                  !connectionsLoading &&
                  connections.length === 0 && (
                    <p className="py-8 text-center text-sm text-zinc-500">
                      暂无连接记录
                    </p>
                  )}
                {!loadingConvs &&
                  connections.map((conn) => {
                    const convs = conversationsByConn[conn.id] || [];
                    const expanded = expandedConnId === conn.id;
                    return (
                      <div key={conn.id} className="mb-1">
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedConnId(expanded ? null : conn.id)
                          }
                          className={`w-full rounded-lg px-3 py-2.5 text-left text-sm ${
                            expanded
                              ? 'bg-zinc-800 text-zinc-100'
                              : 'bg-zinc-800/60 text-zinc-300 active:bg-state-soft'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="min-w-0 truncate">
                              {connLabel(conn)}
                            </span>
                            <span className="flex-shrink-0 text-xs text-zinc-500">
                              {convs.length}
                            </span>
                          </div>
                        </button>
                        {expanded && convs.length === 0 && (
                          <p className="px-4 py-2 text-xs text-zinc-600">
                            该连接暂无会话
                          </p>
                        )}
                        {expanded && convs.length > 0 && (
                          <div className="mt-1 space-y-2 pl-2">
                            {groupConversationsWithPinned(convs).map((group) => (
                              <div key={group.key} className="space-y-1">
                                <div className="px-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                                  {group.label}
                                </div>
                                <ul className="space-y-1">
                                  {group.items.map((conv) => (
                                    <li key={conv.id} className="flex items-center gap-1 rounded-lg bg-zinc-800/40">
                                      <button
                                        type="button"
                                        onClick={() => openConversation(conv)}
                                        className="min-w-0 flex-1 px-3 py-2.5 text-left text-sm text-zinc-300 active:bg-state-soft rounded-lg flex items-center justify-between gap-2"
                                      >
                                        <div className="min-w-0 flex-1">
                                          <div className="truncate font-medium">
                                            {conv.title}
                                          </div>
                                          <div className="mt-0.5 text-[11px] text-zinc-500">
                                            {conv.forkedFromId && <ForkMark />}
                                            {new Date(conv.updatedAt).toLocaleString()}
                                          </div>
                                        </div>
                                        <AgentStatusIndicator
                                          status={getConversationAgentStatus(
                                            conv.id,
                                            tasks,
                                            unreadCompletedConversations,
                                          )}
                                          size="xs"
                                        />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          void setConversationPinned(conv.id, !conv.pinned);
                                        }}
                                        className="mr-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-zinc-400 active:bg-state-soft active:text-zinc-200"
                                        aria-label={conv.pinned ? `取消置顶 ${conv.title}` : `置顶 ${conv.title}`}
                                      >
                                        <Pin className="h-3.5 w-3.5" />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={(e) => handleStartRename(e, conv)}
                                        className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-zinc-400 active:bg-state-soft active:text-zinc-200"
                                        aria-label={`重命名 ${conv.title}`}
                                      >
                                        <Pencil className="h-3.5 w-3.5" />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          void handleArchive(conv.id);
                                        }}
                                        className="mr-1.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-zinc-400 active:bg-state-soft active:text-zinc-200"
                                        aria-label={`归档 ${conv.title}`}
                                        title="归档会话（可恢复）"
                                      >
                                        <Archive className="h-3.5 w-3.5" />
                                      </button>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ))}
                          </div>
                        )}
                        {expanded && showArchived && (
                          <div className="mt-2 space-y-1">
                            <div className="px-2 text-[10px] font-semibold uppercase tracking-wider text-amber-500/80">
                              已归档
                            </div>
                            {(archivedByConn[conn.id] ?? []).length === 0 ? (
                              <p className="px-2 py-2 text-xs text-zinc-600">
                                该连接暂无归档会话
                              </p>
                            ) : (
                              <ul className="space-y-1">
                                {(archivedByConn[conn.id] ?? []).map((conv) => (
                                  <li
                                    key={conv.id}
                                    className="flex items-center gap-1 rounded-lg border border-amber-900/30 bg-amber-950/20"
                                  >
                                    <button
                                      type="button"
                                      onClick={() => openConversation(conv)}
                                      className="min-w-0 flex-1 rounded-lg px-3 py-2.5 text-left text-sm text-zinc-300 active:bg-state-soft"
                                    >
                                      <div className="truncate font-medium">{conv.title}</div>
                                      <div className="mt-0.5 text-[11px] text-zinc-500">
                                        归档于 {conv.archivedAt ? new Date(conv.archivedAt).toLocaleString() : '未知时间'}
                                      </div>
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => void handleRestoreArchived(conv)}
                                      className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-zinc-400 active:bg-state-soft active:text-zinc-200"
                                      aria-label={`恢复 ${conv.title}`}
                                      title="恢复会话"
                                    >
                                      <ArchiveRestore className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setDeleteTarget(conv)}
                                      className="mr-1.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-red-400/80 active:bg-red-950/40"
                                      aria-label={`永久删除 ${conv.title}`}
                                      title="永久删除"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
              </>
            )}
          </div>
        </div>
      )}

      <MobileSheet
        open={renameTarget != null}
        onClose={cancelRename}
        title="重命名会话"
      >
        <div className="flex flex-col gap-3 px-4 pb-4">
          <input
            type="text"
            value={renameInput}
            onChange={(e) => setRenameInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleConfirmRename();
              }
            }}
            placeholder="请输入会话名称"
            className="w-full rounded-xl border border-edge bg-zinc-800 px-3.5 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
            autoFocus
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={cancelRename}
              className="flex-1 rounded-xl bg-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-300 active:bg-state-mid"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void handleConfirmRename()}
              disabled={!renameInput.trim()}
              className="flex-1 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50 active:bg-indigo-500"
            >
              保存
            </button>
          </div>
        </div>
      </MobileSheet>

      <MobileSheet
        open={deleteTarget != null}
        onClose={() => setDeleteTarget(null)}
        title="永久删除会话"
      >
        <div className="flex flex-col gap-3 px-4 pb-4">
          <p className="text-sm leading-relaxed text-zinc-300">
            永久删除「{deleteTarget?.title ?? '该会话'}」？消息会一起删除，此操作不可撤销。
            若只是想让它从列表里消失，请改用归档。
          </p>
          {archiveError && (
            <div
              role="alert"
              className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-xs text-red-300"
            >
              {archiveError}
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void handleDeleteArchived()}
              className="flex-1 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-medium text-white active:bg-red-500"
            >
              永久删除
            </button>
            <button
              type="button"
              onClick={() => setDeleteTarget(null)}
              className="flex-1 rounded-xl bg-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-300 active:bg-state-mid"
            >
              取消
            </button>
          </div>
        </div>
      </MobileSheet>
    </MobileSheet>
  );
}
