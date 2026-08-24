import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import type {
  AgentConversation,
  AgentMessage as AgentMessageType,
  ConversationSearchResult,
  SavedConnection,
} from '@/lib/types';
import * as tauri from '@/lib/tauri';
import {
  storedMessageToAgentMessage,
  clearIntermediateReasoning,
} from '@/stores/messageConversion';
import { useConnectionStore } from '@/stores/connectionStore';
import { useTaskStore } from '@/stores/taskStore';
import { getConversationAgentStatus } from '@/stores/agentStatusSelectors';
import { AgentStatusIndicator } from '@/components/agent/AgentStatusIndicator';
import { usePrivacyMode } from '@/hooks/usePrivacyMode';
import { formatNameWithAddress } from '@/lib/privacy';
import { groupConversationsByDate } from '@/lib/dateGrouping';
import { Pencil } from 'lucide-react';
import AgentMessageList from '@/components/agent/AgentMessageList';
import MobileSheet from './ui/MobileSheet';

interface MobileChatHistorySheetProps {
  open: boolean;
  onClose: () => void;
}

const matchCountLabel = (n: number) =>
  n > 200 ? '共 200+ 条匹配' : `共 ${n} 条匹配`;

/**
 * 移动端聊天历史浏览面板（只读）。
 *
 * 与桌面 ChatHistoryModal 对齐：按连接维度加载所有历史会话
 * （agentListConversationsByConnection），支持全文搜索
 * （agentSearchConversations）与匹配项上一条/下一条定位。
 * 全部状态为组件本地状态，不触碰 conversationStore 的 activeConversation。
 */
export default function MobileChatHistorySheet({
  open,
  onClose,
}: MobileChatHistorySheetProps) {
  const connections = useConnectionStore((s) => s.connections);
  const connectionsLoading = useConnectionStore((s) => s.loading);
  const tasks = useTaskStore((s) => s.tasks);
  const unreadCompletedConversations = useTaskStore(
    (s) => s.unreadCompletedConversations,
  );
  const fetchConnections = useConnectionStore((s) => s.fetchConnections);
  const privacyMode = usePrivacyMode();
  const connLabel = (c: SavedConnection) =>
    formatNameWithAddress(c.name, c.host, c.port, privacyMode);
  const [expandedConnId, setExpandedConnId] = useState<string | null>(null);
  const [conversationsByConn, setConversationsByConn] = useState<
    Record<string, AgentConversation[]>
  >({});
  const [selectedConv, setSelectedConv] = useState<AgentConversation | null>(
    null,
  );
  const [messages, setMessages] = useState<AgentMessageType[]>([]);
  const [loadingConvs, setLoadingConvs] = useState(false);
  const [loadingMsgs, setLoadingMsgs] = useState(false);

  const [renameConvTarget, setRenameConvTarget] = useState<AgentConversation | null>(null);
  const [renameInput, setRenameInput] = useState('');

  const handleStartRename = (e: React.MouseEvent, conv: AgentConversation) => {
    e.stopPropagation();
    setRenameConvTarget(conv);
    setRenameInput(conv.title);
  };

  const handleConfirmRename = async () => {
    if (!renameConvTarget) return;
    const trimmed = renameInput.trim();
    if (trimmed && trimmed !== renameConvTarget.title) {
      try {
        await tauri.agentRenameConversation(renameConvTarget.id, trimmed);
        const now = new Date().toISOString();
        setConversationsByConn((prev) => {
          const next = { ...prev };
          for (const connId of Object.keys(next)) {
            next[connId] = next[connId].map((c) =>
              c.id === renameConvTarget.id ? { ...c, title: trimmed, updatedAt: now } : c,
            );
          }
          return next;
        });
        setSearchResults((prev) =>
          prev.map((r) => (r.conversationId === renameConvTarget.id ? { ...r, title: trimmed } : r)),
        );
        if (selectedConv?.id === renameConvTarget.id) {
          setSelectedConv((prev) => (prev ? { ...prev, title: trimmed, updatedAt: now } : null));
        }
      } catch (err) {
        console.error('Failed to rename conversation:', err);
      }
    }
    setRenameConvTarget(null);
    setRenameInput('');
  };

  const [searchInput, setSearchInput] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [searchResults, setSearchResults] = useState<
    ConversationSearchResult[]
  >([]);
  const [loadingSearch, setLoadingSearch] = useState(false);
  const [activeMatchIds, setActiveMatchIds] = useState<string[]>([]);
  const [matchIndex, setMatchIndex] = useState(0);
  const [highlightMessageId, setHighlightMessageId] = useState<string | null>(
    null,
  );
  const searchSeqRef = useRef(0);
  const pendingNavRef = useRef(false);

  const isSearching = debouncedQuery.trim().length > 0;

  // 关闭时重置全部状态（与桌面 ChatHistoryModal 一致）
  useEffect(() => {
    if (!open) {
      setExpandedConnId(null);
      setSelectedConv(null);
      setMessages([]);
      setConversationsByConn({});
      setSearchInput('');
      setDebouncedQuery('');
      setSearchResults([]);
      setLoadingSearch(false);
      setActiveMatchIds([]);
      setMatchIndex(0);
      setHighlightMessageId(null);
      pendingNavRef.current = false;
    }
  }, [open]);

  // 搜索防抖 300ms
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => setDebouncedQuery(searchInput), 300);
    return () => window.clearTimeout(t);
  }, [searchInput, open]);

  // 移动端连接列表可能尚未加载（仅终端页会触发 fetch），打开面板时补一次
  useEffect(() => {
    if (!open) return;
    void fetchConnections();
  }, [open, fetchConnections]);

  // 按连接维度加载所有历史会话
  useEffect(() => {
    if (!open) return;
    if (connections.length === 0) return;
    let cancelled = false;
    (async () => {
      setLoadingConvs(true);
      const byConn: Record<string, AgentConversation[]> = {};
      for (const conn of connections) {
        try {
          byConn[conn.id] = await tauri.agentListConversationsByConnection(
            conn.id,
          );
        } catch {
          byConn[conn.id] = [];
        }
      }
      if (cancelled) return;
      setConversationsByConn(byConn);
      setLoadingConvs(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, connections]);

  // 全文搜索（seq 防止过期结果覆盖新结果）
  useEffect(() => {
    if (!open) return;
    const q = debouncedQuery.trim();
    if (!q) {
      setSearchResults([]);
      setLoadingSearch(false);
      setActiveMatchIds([]);
      setMatchIndex(0);
      setHighlightMessageId(null);
      return;
    }
    const seq = ++searchSeqRef.current;
    setLoadingSearch(true);
    (async () => {
      try {
        const results = await tauri.agentSearchConversations(q);
        if (seq !== searchSeqRef.current) return;
        setSearchResults(results);
      } catch {
        if (seq !== searchSeqRef.current) return;
        setSearchResults([]);
      } finally {
        if (seq === searchSeqRef.current) setLoadingSearch(false);
      }
    })();
  }, [debouncedQuery, open]);

  // 加载选中会话的消息（只读）
  const selectedConvId = selectedConv?.id ?? null;
  useEffect(() => {
    if (!selectedConvId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    setLoadingMsgs(true);
    (async () => {
      try {
        const stored = await tauri.agentLoadConversation(selectedConvId);
        if (cancelled) return;
        setMessages(
          clearIntermediateReasoning(stored.map(storedMessageToAgentMessage)),
        );
      } catch {
        if (!cancelled) setMessages([]);
      } finally {
        if (!cancelled) setLoadingMsgs(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedConvId]);

  // 消息加载完成后定位到第 1 条匹配
  useEffect(() => {
    if (loadingMsgs) return;
    if (!pendingNavRef.current) return;
    if (activeMatchIds.length === 0) {
      pendingNavRef.current = false;
      return;
    }
    pendingNavRef.current = false;
    setMatchIndex(0);
    setHighlightMessageId(activeMatchIds[0]);
  }, [loadingMsgs, messages, activeMatchIds]);

  const connNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of connections) m.set(c.id, connLabel(c));
    return m;
  }, [connections]);

  const groupedSearch = useMemo(() => {
    const groups: {
      connectionId: string;
      label: string;
      items: ConversationSearchResult[];
    }[] = [];
    const index = new Map<string, number>();
    for (const r of searchResults) {
      let i = index.get(r.connectionId);
      if (i === undefined) {
        i = groups.length;
        index.set(r.connectionId, i);
        groups.push({
          connectionId: r.connectionId,
          label: connNameById.get(r.connectionId) || r.connectionId,
          items: [],
        });
      }
      groups[i].items.push(r);
    }
    return groups;
  }, [searchResults, connNameById]);

  const openConversation = useCallback((conv: AgentConversation) => {
    setActiveMatchIds([]);
    setMatchIndex(0);
    setHighlightMessageId(null);
    pendingNavRef.current = false;
    setSelectedConv(conv);
  }, []);

  const openSearchResult = useCallback((r: ConversationSearchResult) => {
    setActiveMatchIds(r.matchedMessageIds);
    setMatchIndex(0);
    setHighlightMessageId(null);
    pendingNavRef.current = true;
    setSelectedConv({
      id: r.conversationId,
      connectionId: r.connectionId,
      title: r.title,
      createdAt: r.updatedAt,
      updatedAt: r.updatedAt,
    });
  }, []);

  const handleBack = useCallback(() => {
    setSelectedConv(null);
    setMessages([]);
    setActiveMatchIds([]);
    setMatchIndex(0);
    setHighlightMessageId(null);
    pendingNavRef.current = false;
  }, []);

  const goMatch = useCallback(
    (delta: number) => {
      if (activeMatchIds.length === 0) return;
      setMatchIndex((prev) => {
        const next = prev + delta;
        if (next < 0 || next >= activeMatchIds.length) return prev;
        setHighlightMessageId(activeMatchIds[next]);
        return next;
      });
    },
    [activeMatchIds],
  );

  const clearSearch = useCallback(() => {
    setSearchInput('');
    setDebouncedQuery('');
    setSearchResults([]);
    setActiveMatchIds([]);
    setMatchIndex(0);
    setHighlightMessageId(null);
    pendingNavRef.current = false;
  }, []);

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
                              onClick={() => openSearchResult(r)}
                              className="w-full rounded-lg bg-zinc-800/60 px-3 py-2.5 text-left text-sm text-zinc-300 active:bg-zinc-800"
                            >
                              <div className="truncate font-medium">
                                {r.title}
                              </div>
                              <div className="mt-0.5 line-clamp-2 break-words text-xs text-zinc-500">
                                {r.matchedSnippet}
                              </div>
                              <div className="mt-0.5 text-xs text-indigo-400/80">
                                {matchCountLabel(r.matchCount)}
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
        open={renameConvTarget != null}
        onClose={() => setRenameConvTarget(null)}
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
              onClick={() => setRenameConvTarget(null)}
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
