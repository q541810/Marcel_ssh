import { useEffect, useMemo, useCallback, useState } from 'react';
import { Archive, ArchiveRestore, Pencil, Pin, Search, Trash2, X } from 'lucide-react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import Modal from '@/components/ui/Modal';
import Toggle from '@/components/ui/Toggle';
import { useConversationStore } from '@/stores/conversationStore';
import { getErrorMessage } from '@/lib/errors';
import type { SavedConnection } from '@/lib/types';
import { useConnectionStore } from '@/stores/connectionStore';
import { usePrivacyMode } from '@/hooks/usePrivacyMode';
import { formatNameWithAddress } from '@/lib/privacy';
import { groupConversationsWithPinned } from '@/lib/dateGrouping';
import AgentMessageList from '@/components/agent/AgentMessageList';
import { ForkMark } from '@/components/agent/ForkMark';
import { useTaskStore } from '@/stores/taskStore';
import {
  useConversationHistoryStore,
  groupSearchResultsByConnection,
  formatMatchCountLabel,
} from '@/stores/conversationHistoryManager';
import { buildConversationAgentStatusMap } from '@/stores/agentStatusSelectors';
import { AgentStatusIndicator } from '@/components/agent/AgentStatusIndicator';
import { orphanSearchLabel } from '@/lib/orphanConversations';
import DeletedServerGroups from './DeletedServerGroups';

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function ChatHistoryModal({ open, onClose }: Props) {
  const connections = useConnectionStore((s) => s.connections);
  const privacyMode = usePrivacyMode();
  const tasks = useTaskStore((s) => s.tasks);
  const unreadCompletedConversations = useTaskStore(
    (s) => s.unreadCompletedConversations,
  );
  // 状态一次建映射（每行单查 = 每行扫一遍全表，见 buildConversationAgentStatusMap）
  const statusMap = useMemo(
    () => buildConversationAgentStatusMap(tasks, unreadCompletedConversations),
    [tasks, unreadCompletedConversations],
  );

  // 从 manager 中订阅状态
  const conversationsByConn = useConversationHistoryStore((s) => s.conversationsByConn);
  const loadingConvs = useConversationHistoryStore((s) => s.loadingConvs);
  const selectedConnId = useConversationHistoryStore((s) => s.selectedConnId);
  const selectedConvId = useConversationHistoryStore((s) => s.selectedConvId);
  const selectedConv = useConversationHistoryStore((s) => s.selectedConv);
  const messages = useConversationHistoryStore((s) => s.messages);
  const loadingMsgs = useConversationHistoryStore((s) => s.loadingMsgs);

  const searchInput = useConversationHistoryStore((s) => s.searchInput);
  const debouncedQuery = useConversationHistoryStore((s) => s.debouncedQuery);
  const searchResults = useConversationHistoryStore((s) => s.searchResults);
  const loadingSearch = useConversationHistoryStore((s) => s.loadingSearch);

  const activeMatchIds = useConversationHistoryStore((s) => s.activeMatchIds);
  const matchIndex = useConversationHistoryStore((s) => s.matchIndex);
  const highlightMessageId = useConversationHistoryStore((s) => s.highlightMessageId);

  // manager actions
  const loadAllConnections = useConversationHistoryStore((s) => s.loadAllConnections);
  const orphanGroups = useConversationHistoryStore((s) => s.orphanGroups);
  const loadOrphanGroups = useConversationHistoryStore((s) => s.loadOrphanGroups);
  const setSelectedConnId = useConversationHistoryStore((s) => s.setSelectedConnId);
  const selectConversation = useConversationHistoryStore((s) => s.selectConversation);
  const openSearchResult = useConversationHistoryStore((s) => s.openSearchResult);
  const setSearchInput = useConversationHistoryStore((s) => s.setSearchInput);
  const clearSearch = useConversationHistoryStore((s) => s.clearSearch);
  const goMatch = useConversationHistoryStore((s) => s.goMatch);
  const confirmRename = useConversationHistoryStore((s) => s.confirmRename);
  const setConversationPinned = useConversationHistoryStore((s) => s.setConversationPinned);
  const reset = useConversationHistoryStore((s) => s.reset);

  // 归档视图：开关 + 归档/恢复/永久删除（归档列表缓存放在 live store，
  // 与抽屉共用一份，避免两处各自维护一份「已归档」）
  const showArchived = useConversationHistoryStore((s) => s.showArchived);
  const setShowArchived = useConversationHistoryStore((s) => s.setShowArchived);
  const archiveConversation = useConversationHistoryStore((s) => s.archiveConversation);
  const unarchiveConversation = useConversationHistoryStore((s) => s.unarchiveConversation);
  const deleteArchivedConversation = useConversationHistoryStore(
    (s) => s.deleteArchivedConversation,
  );
  const archivedByConn = useConversationStore((s) => s.archivedConversations);
  const archivedLoadingByConn = useConversationStore((s) => s.archivedLoading);
  const loadArchivedConversations = useConversationStore(
    (s) => s.loadArchivedConversations,
  );
  const [actionError, setActionError] = useState<string | null>(null);

  const isSearching = debouncedQuery.trim().length > 0;

  // 打开/关闭时状态管理
  useEffect(() => {
    if (!open) {
      reset();
    } else if (connections.length > 0) {
      void loadAllConnections(connections);
    }
  }, [open, connections, loadAllConnections, reset]);

  // 已删除的服务器分组：与现存连接无关（连接删光了也要能看到），打开时单独拉一次。
  // 连接列表变了（删了一台、转移走一批）也重拉，分组随之更新。
  useEffect(() => {
    if (open) void loadOrphanGroups();
  }, [open, connections, loadOrphanGroups]);

  // 打开「显示已归档」时按连接拉归档列表（缓存在 live store，抽屉共用）。
  useEffect(() => {
    if (!open || !showArchived) return;
    for (const conn of connections) {
      void loadArchivedConversations(conn.id);
    }
  }, [open, showArchived, connections, loadArchivedConversations]);

  const handleArchiveConversation = useCallback(
    async (e: React.MouseEvent, conversationId: string) => {
      e.stopPropagation();
      setActionError(null);
      try {
        await archiveConversation(conversationId);
      } catch (err) {
        // 典型失败：会话正在运行/压缩 —— 原样展示原因
        setActionError(getErrorMessage(err));
      }
    },
    [archiveConversation],
  );

  const handleUnarchiveConversation = useCallback(
    async (e: React.MouseEvent, conversationId: string, connectionId: string) => {
      e.stopPropagation();
      setActionError(null);
      try {
        await unarchiveConversation(conversationId, connectionId);
      } catch (err) {
        setActionError(getErrorMessage(err));
      }
    },
    [unarchiveConversation],
  );

  const handleDeleteArchived = useCallback(
    async (e: React.MouseEvent, conversationId: string) => {
      e.stopPropagation();
      if (!window.confirm('永久删除后无法恢复，确定删除这个会话吗？')) return;
      setActionError(null);
      try {
        await deleteArchivedConversation(conversationId);
      } catch (err) {
        setActionError(getErrorMessage(err));
      }
    },
    [deleteArchivedConversation],
  );

  // 历史是只读浏览，但复制照样要能用（用户消息下的复制、任务收尾条的复制）。
  const handleCopyMessage = useCallback(async (message: { content: string }) => {
    try {
      await writeText(message.content);
    } catch (err) {
      console.error('Failed to copy message:', err);
    }
  }, []);
  const handleCopyText = useCallback(async (text: string) => {
    await writeText(text);
  }, []);

  const handleRenameInModal = async (e: React.MouseEvent, convId: string, oldTitle: string) => {
    e.stopPropagation();
    const newTitle = window.prompt('请输入新的会话名称', oldTitle);
    if (!newTitle || !newTitle.trim() || newTitle.trim() === oldTitle) return;
    await confirmRename(convId, newTitle.trim());
  };

  const connLabel = useCallback(
    (c: SavedConnection) => formatNameWithAddress(c.name, c.host, c.port, privacyMode),
    [privacyMode],
  );

  const connNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of connections) m.set(c.id, connLabel(c));
    for (const g of orphanGroups) m.set(g.connectionId, orphanSearchLabel(g, privacyMode));
    return m;
  }, [connections, connLabel, orphanGroups, privacyMode]);

  const selectedConn = connections.find((c) => c.id === selectedConnId);
  const selectedOrphan = orphanGroups.find((g) => g.connectionId === selectedConnId);

  const groupedSearch = useMemo(() => {
    return groupSearchResultsByConnection(searchResults, connNameById);
  }, [searchResults, connNameById]);

  return (
    <Modal open={open} onClose={onClose} title="聊天历史记录" size="xl">
      <div className="flex flex-col flex-1 overflow-hidden">
        {/* Search bar */}
        <div className="px-3 pt-1 pb-2 border-b border-edge-subtle flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <Search size={16} strokeWidth={1.5} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-tertiary pointer-events-none" />
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="搜索聊天记录…"
                className="w-full rounded-lg field pl-9 pr-8 py-2 text-body text-fg"
              />
              {searchInput && (
                <button
                  type="button"
                  onClick={clearSearch}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-fg-tertiary hover:text-fg"
                  title="清除"
                >
                  <X size={16} strokeWidth={1.5} />
                </button>
              )}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <Toggle
                checked={showArchived}
                onChange={setShowArchived}
                label="显示已归档"
                size="sm"
              />
            </div>
          </div>
          {actionError && (
            <div
              role="alert"
              className="mt-2 rounded-lg border border-red-900 bg-red-950/60 px-2 py-2 text-meta text-red-300"
            >
              {actionError}
            </div>
          )}
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Left sidebar */}
          <div className="w-64 flex-shrink-0 bg-surface-raised border-r border-edge overflow-y-auto p-2 space-y-1">
            {isSearching ? (
              <>
                {loadingSearch && (
                  <div className="p-4 text-body text-fg-tertiary">搜索中…</div>
                )}
                {!loadingSearch && searchResults.length === 0 && (
                  <div className="p-4 text-body text-fg-tertiary">没有找到匹配的聊天记录</div>
                )}
                {!loadingSearch &&
                  groupedSearch.map((group) => (
                    <div key={group.connectionId} className="space-y-1 mb-2">
                      <div className="px-3 py-1 text-meta font-medium text-fg-tertiary truncate">
                        {group.label}
                      </div>
                      {group.items.map((r) => (
                        <button
                          key={r.conversationId}
                          type="button"
                          className={`w-full text-left px-3 py-2 rounded-lg text-body transition-colors ${
                            selectedConvId === r.conversationId
                              ? 'bg-zinc-700 text-fg'
                              : 'text-fg-secondary hover:bg-state-mid hover:text-fg'
                          }`}
                          onClick={() => void openSearchResult(r)}
                        >
                          <div className="truncate font-medium">{r.title}</div>
                          <div className="text-meta text-fg-tertiary mt-1 line-clamp-2 break-words">
                            {r.matchedSnippet}
                          </div>
                          <div className="text-meta text-indigo-400/80 mt-1">
                            {formatMatchCountLabel(r.matchCount)}
                          </div>
                        </button>
                      ))}
                    </div>
                  ))}
              </>
            ) : (
              <>
                {loadingConvs && (
                  <div className="p-4 text-body text-fg-tertiary">加载中...</div>
                )}
                {!loadingConvs && connections.length === 0 && orphanGroups.length === 0 && (
                  <div className="p-4 text-body text-fg-tertiary">暂无连接记录</div>
                )}
                {connections.map((conn) => {
                  const convs = conversationsByConn[conn.id] || [];
                  const archived = archivedByConn[conn.id] || [];
                  const archivedLoading = !!archivedLoadingByConn[conn.id];
                  const isSelected = selectedConnId === conn.id;
                  return (
                    <div key={conn.id} className="space-y-1">
                      <button
                        type="button"
                        className={`w-full text-left px-3 py-2 rounded-lg text-body transition-colors ${
                          isSelected
                            ? 'bg-zinc-700 text-fg'
                            : 'text-fg-secondary hover:bg-state-mid hover:text-fg'
                        }`}
                        onClick={() => {
                          setSelectedConnId(isSelected ? null : conn.id);
                        }}
                      >
                        <div className="flex items-center justify-between">
                          <span className="truncate">{connLabel(conn)}</span>
                          <span className="ml-2 text-meta text-fg-tertiary flex-shrink-0">
                            {showArchived && archived.length > 0
                              ? `${convs.length} + ${archived.length}`
                              : convs.length}
                          </span>
                        </div>
                      </button>
                      {isSelected && convs.length > 0 && (
                        <div className="space-y-2 pl-2 mt-1">
                          {groupConversationsWithPinned(convs).map((group) => (
                            <div key={group.key} className="space-y-1">
                              <div className="px-2 py-0.5 text-caption font-semibold text-fg-tertiary uppercase tracking-wider">
                                {group.label}
                              </div>
                              {group.items.map((conv) => (
                                <div
                                  key={conv.id}
                                  className={`group/conv flex items-center justify-between px-2 py-2 rounded-lg text-body transition-colors ${
                                    selectedConvId === conv.id
                                      ? 'bg-zinc-700 text-fg ring-1 ring-edge-strong'
                                      : 'text-fg-secondary hover:bg-state-mid/60 hover:text-fg'
                                  }`}
                                >
                                  <button
                                    type="button"
                                    className="flex-1 text-left min-w-0 flex items-center justify-between gap-2"
                                    onClick={() => {
                                      void selectConversation(
                                        conv.id === selectedConvId ? null : conv,
                                        conn.id,
                                      );
                                    }}
                                  >
                                    <div className="min-w-0 flex-1">
                                      <div className="truncate font-medium">{conv.title}</div>
                                      <div className="text-caption text-fg-tertiary mt-1">
                                        {conv.forkedFromId && <ForkMark />}
                                        {new Date(conv.updatedAt).toLocaleString()}
                                      </div>
                                    </div>
                                    <AgentStatusIndicator
                                      status={statusMap.get(conv.id) ?? 'idle'}
                                      size="xs"
                                    />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void setConversationPinned(conv.id, !conv.pinned);
                                    }}
                                    className="p-1 rounded text-fg-tertiary hover:text-fg hover:bg-state-strong transition-colors opacity-0 group-hover/conv:opacity-100 flex-shrink-0"
                                    title={conv.pinned ? '取消置顶' : '置顶会话'}
                                    aria-label={conv.pinned ? '取消置顶' : '置顶会话'}
                                  >
                                    <Pin className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={(e) => handleRenameInModal(e, conv.id, conv.title)}
                                    className="p-1 rounded text-fg-tertiary hover:text-fg hover:bg-state-strong transition-colors opacity-0 group-hover/conv:opacity-100 flex-shrink-0"
                                    title="重命名会话"
                                  >
                                    <Pencil size={14} strokeWidth={1.5} />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={(e) => void handleArchiveConversation(e, conv.id)}
                                    className="p-1 rounded text-fg-tertiary hover:text-amber-300 hover:bg-state-strong transition-colors opacity-0 group-hover/conv:opacity-100 flex-shrink-0"
                                    title="归档会话（可恢复）"
                                    aria-label="归档会话"
                                  >
                                    <Archive className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          ))}
                        </div>
                      )}
                      {isSelected && showArchived && (
                        <div className="space-y-1 pl-2 mt-1">
                          <div className="px-2 py-0.5 text-caption font-semibold text-fg-tertiary uppercase tracking-wider">
                            已归档
                          </div>
                          {archivedLoading && archived.length === 0 && (
                            <div className="px-2 py-1 text-caption text-fg-disabled">加载中…</div>
                          )}
                          {!archivedLoading && archived.length === 0 && (
                            <div className="px-2 py-1 text-caption text-fg-disabled">暂无归档会话</div>
                          )}
                          {archived.map((conv) => (
                            <div
                              key={conv.id}
                              className={`group/conv flex items-center justify-between px-2 py-2 rounded-lg text-body transition-colors ${
                                selectedConvId === conv.id
                                  ? 'bg-zinc-700 text-fg ring-1 ring-edge-strong'
                                  : 'text-fg-secondary hover:bg-state-mid/60 hover:text-fg'
                              }`}
                            >
                              <button
                                type="button"
                                className="flex-1 text-left min-w-0"
                                onClick={() => {
                                  void selectConversation(
                                    conv.id === selectedConvId ? null : conv,
                                    conn.id,
                                  );
                                }}
                              >
                                <div className="truncate font-medium">{conv.title}</div>
                                <div className="text-caption text-fg-tertiary mt-1">
                                  归档于{" "}
                                  {new Date(conv.archivedAt ?? conv.updatedAt).toLocaleString()}
                                </div>
                              </button>
                              <button
                                type="button"
                                onClick={(e) =>
                                  void handleUnarchiveConversation(e, conv.id, conn.id)
                                }
                                className="p-1 rounded text-fg-tertiary hover:text-emerald-300 hover:bg-state-strong transition-colors opacity-0 group-hover/conv:opacity-100 flex-shrink-0"
                                title="恢复到会话列表"
                                aria-label="恢复会话"
                              >
                                <ArchiveRestore className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={(e) => void handleDeleteArchived(e, conv.id)}
                                className="p-1 rounded text-fg-tertiary hover:text-red-400 hover:bg-state-strong transition-colors opacity-0 group-hover/conv:opacity-100 flex-shrink-0"
                                title="永久删除"
                                aria-label="永久删除会话"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      {isSelected && convs.length === 0 && !showArchived && (
                        <div className="pl-5 pr-3 py-2 text-meta text-fg-disabled">该连接暂无会话</div>
                      )}
                    </div>
                  );
                })}
                <DeletedServerGroups />
              </>
            )}
          </div>

          {/* Right content */}
          <div className="flex-1 flex flex-col bg-surface overflow-hidden">
            {selectedConv && (
              <div className="flex items-center justify-between px-4 py-3 border-b border-edge-subtle flex-shrink-0">
                <div className="min-w-0">
                  <h4 className="text-body font-semibold text-fg truncate">{selectedConv.title}</h4>
                  {selectedConn ? (
                    <p className="text-meta text-fg-tertiary truncate">{connLabel(selectedConn)}</p>
                  ) : (
                    selectedOrphan && (
                      <p className="text-meta text-fg-tertiary truncate">
                        {orphanSearchLabel(selectedOrphan, privacyMode)}
                      </p>
                    )
                  )}
                </div>
                <span className="text-meta text-fg-disabled flex-shrink-0 ml-3">
                  {new Date(selectedConv.updatedAt).toLocaleString()}
                </span>
              </div>
            )}

            {activeMatchIds.length > 0 && selectedConvId && (
              <div className="flex items-center justify-center gap-3 px-4 py-2 border-b border-indigo-500/15 bg-indigo-500/5 sticky top-0 z-10 flex-shrink-0 text-meta text-fg-secondary">
                <span className="text-indigo-300/90">
                  匹配到 {activeMatchIds.length}
                  {activeMatchIds.length >= 200 ? '+' : ''} 条结果
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={matchIndex <= 0}
                    onClick={() => goMatch(-1)}
                    className="px-2 py-0.5 rounded text-indigo-200/80 hover:bg-indigo-500/15 disabled:opacity-30 disabled:cursor-not-allowed"
                    title="上一条"
                  >
                    ◀
                  </button>
                  <span className="tabular-nums text-fg-secondary min-w-[3rem] text-center">
                    {matchIndex + 1}/{activeMatchIds.length}
                  </span>
                  <button
                    type="button"
                    disabled={matchIndex >= activeMatchIds.length - 1}
                    onClick={() => goMatch(1)}
                    className="px-2 py-0.5 rounded text-indigo-200/80 hover:bg-indigo-500/15 disabled:opacity-30 disabled:cursor-not-allowed"
                    title="下一条"
                  >
                    ▶
                  </button>
                </div>
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-4 space-y-1">
              {loadingMsgs && (
                <div className="p-4 text-body text-fg-tertiary">加载消息...</div>
              )}
              {!loadingMsgs && !selectedConvId && (
                <div className="flex items-center justify-center h-full text-body text-fg-tertiary">
                  请选择一个会话查看消息
                </div>
              )}
              {!loadingMsgs && selectedConvId && messages.length === 0 && (
                <div className="flex items-center justify-center h-full text-body text-fg-tertiary">
                  该会话暂无消息
                </div>
              )}
              {!loadingMsgs && messages.length > 0 && (
                <AgentMessageList
                  messages={messages}
                  onCopy={handleCopyMessage}
                  onCopyText={handleCopyText}
                  highlightMessageId={highlightMessageId}
                  matchedMessageIds={activeMatchIds}
                  searchKeyword={isSearching ? debouncedQuery.trim() : undefined}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
