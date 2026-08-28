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
import { usePrivacyMode } from '@/hooks/usePrivacyMode';
import { formatNameWithAddress } from '@/lib/privacy';
import { groupConversationsByDate } from '@/lib/dateGrouping';
import {
  useConversationHistoryStore,
  groupSearchResultsByConnection,
  formatMatchCountLabel,
} from '@/stores/conversationHistoryManager';
import { Pencil } from 'lucide-react';
import AgentMessageList from '@/components/agent/AgentMessageList';
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
              className="-ml-1 flex-shrink-0 rounded-lg px-2 py-1 text-xs text-indigo-300 active:bg-zinc-800"
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
                  className="rounded-lg bg-zinc-800 px-3.5 py-1 text-sm text-zinc-200 active:bg-zinc-700 disabled:opacity-30"
                  aria-label="上一条匹配"
                >
                  ▲
                </button>
                <button
                  type="button"
                  disabled={matchIndex >= activeMatchIds.length - 1}
                  onClick={() => goMatch(1)}
                  className="rounded-lg bg-zinc-800 px-3.5 py-1 text-sm text-zinc-200 active:bg-zinc-700 disabled:opacity-30"
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
                isThinking={false}
                // 只读浏览：借 isRunning 将撤回按钮置为 disabled
                isRunning
                onCopy={(m) => void handleCopyMessage(m)}
                highlightMessageId={highlightMessageId}
                matchedMessageIds={activeMatchIds}
                searchKeyword={
                  isSearching ? debouncedQuery.trim() : undefined
                }
                alwaysShowActions
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
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 py-2 pl-9 pr-9 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-500 focus:outline-none"
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
          </div>

          <div className="px-3 pb-3">
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
                              className="w-full rounded-lg bg-zinc-800/60 px-3 py-2.5 text-left text-sm text-zinc-300 active:bg-zinc-800"
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
                              : 'bg-zinc-800/60 text-zinc-300 active:bg-zinc-800'
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
                            {groupConversationsByDate(convs).map((group) => (
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
                                        className="min-w-0 flex-1 px-3 py-2.5 text-left text-sm text-zinc-300 active:bg-zinc-800 rounded-lg flex items-center justify-between gap-2"
                                      >
                                        <div className="min-w-0 flex-1">
                                          <div className="truncate font-medium">
                                            {conv.title}
                                          </div>
                                          <div className="mt-0.5 text-[11px] text-zinc-500">
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
                                        onClick={(e) => handleStartRename(e, conv)}
                                        className="mr-1.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-zinc-400 active:bg-zinc-800 active:text-zinc-200"
                                        aria-label={`重命名 ${conv.title}`}
                                      >
                                        <Pencil className="h-3.5 w-3.5" />
                                      </button>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ))}
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
            className="w-full rounded-xl border border-zinc-700 bg-zinc-800 px-3.5 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
            autoFocus
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={cancelRename}
              className="flex-1 rounded-xl bg-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-300 active:bg-zinc-700"
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
    </MobileSheet>
  );
}
