import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Modal from '@/components/ui/Modal';
import type {
  SavedConnection,
  AgentConversation,
  AgentMessage as AgentMessageType,
  ConversationSearchResult,
} from '@/lib/types';
import * as tauri from '@/lib/tauri';
import { storedMessageToAgentMessage, clearIntermediateReasoning } from '@/stores/messageConversion';
import { useConnectionStore } from '@/stores/connectionStore';
import { usePrivacyMode } from '@/hooks/usePrivacyMode';
import { formatNameWithAddress } from '@/lib/privacy';
import { groupConversationsByDate } from '@/lib/dateGrouping';
import AgentMessageList from '@/components/agent/AgentMessageList';
import { useTaskStore } from '@/stores/taskStore';
import { useConversationStore } from '@/stores/conversationStore';
import { getConversationAgentStatus } from '@/stores/agentStatusSelectors';
import { AgentStatusIndicator } from '@/components/agent/AgentStatusIndicator';
import { getErrorMessage } from '@/lib/errors';

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function ChatHistoryModal({ open, onClose }: Props) {
  const connections = useConnectionStore((s) => s.connections);
  const [selectedConnId, setSelectedConnId] = useState<string | null>(null);
  const [conversationsByConn, setConversationsByConn] = useState<Record<string, AgentConversation[]>>({});
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessageType[]>([]);
  const [loadingConvs, setLoadingConvs] = useState(false);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const privacyMode = usePrivacyMode();
  const tasks = useTaskStore((s) => s.tasks);
  const unreadCompletedConversations = useTaskStore(
    (s) => s.unreadCompletedConversations,
  );

  const handleRenameInModal = async (e: React.MouseEvent, convId: string, oldTitle: string) => {
    e.stopPropagation();
    const newTitle = window.prompt('请输入新的会话名称', oldTitle);
    if (!newTitle || !newTitle.trim() || newTitle.trim() === oldTitle) return;
    try {
      await useConversationStore.getState().renameConversation(convId, newTitle.trim());
      // 更新本地状态
      setConversationsByConn((prev) => {
        const next = { ...prev };
        for (const connId of Object.keys(next)) {
          next[connId] = next[connId].map((c) =>
            c.id === convId ? { ...c, title: newTitle.trim(), updatedAt: new Date().toISOString() } : c,
          );
        }
        return next;
      });
      setSearchResults((prev) =>
        prev.map((r) => (r.conversationId === convId ? { ...r, title: newTitle.trim() } : r)),
      );
    } catch (err) {
      console.error('Failed to rename conversation:', getErrorMessage(err));
    }
  };

  const [searchInput, setSearchInput] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ConversationSearchResult[]>([]);
  const [loadingSearch, setLoadingSearch] = useState(false);
  const [activeMatchIds, setActiveMatchIds] = useState<string[]>([]);
  const [matchIndex, setMatchIndex] = useState(0);
  const [highlightMessageId, setHighlightMessageId] = useState<string | null>(null);
  const searchSeqRef = useRef(0);
  const pendingNavRef = useRef(false);

  const isSearching = debouncedQuery.trim().length > 0;

  useEffect(() => {
    if (!open) {
      setSelectedConnId(null);
      setSelectedConvId(null);
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

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => setDebouncedQuery(searchInput), 300);
    return () => window.clearTimeout(t);
  }, [searchInput, open]);

  useEffect(() => {
    if (!open) return;
    const loadAll = async () => {
      setLoadingConvs(true);
      const byConn: Record<string, AgentConversation[]> = {};
      for (const conn of connections) {
        try {
          const convs = await tauri.agentListConversationsByConnection(conn.id);
          byConn[conn.id] = convs;
        } catch {
          byConn[conn.id] = [];
        }
      }
      setConversationsByConn(byConn);
      setLoadingConvs(false);
    };
    if (connections.length > 0) loadAll();
  }, [open, connections]);

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

  useEffect(() => {
    if (!selectedConvId) {
      setMessages([]);
      return;
    }
    const load = async () => {
      setLoadingMsgs(true);
      try {
        const stored = await tauri.agentLoadConversation(selectedConvId);
        const msgs = clearIntermediateReasoning(stored.map(storedMessageToAgentMessage));
        setMessages(msgs);
      } catch {
        setMessages([]);
      }
      setLoadingMsgs(false);
    };
    load();
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

  const connLabel = (c: SavedConnection) => formatNameWithAddress(c.name, c.host, c.port, privacyMode);

  const connNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of connections) m.set(c.id, connLabel(c));
    return m;
  }, [connections]);

  const selectedConn = connections.find((c) => c.id === selectedConnId);
  const selectedConv = useMemo(() => {
    if (!selectedConvId) return undefined;
    if (selectedConnId) {
      const fromTree = (conversationsByConn[selectedConnId] || []).find((c) => c.id === selectedConvId);
      if (fromTree) return fromTree;
    }
    const fromSearch = searchResults.find((r) => r.conversationId === selectedConvId);
    if (fromSearch) {
      return {
        id: fromSearch.conversationId,
        connectionId: fromSearch.connectionId,
        title: fromSearch.title,
        createdAt: fromSearch.updatedAt,
        updatedAt: fromSearch.updatedAt,
      } satisfies AgentConversation;
    }
    return undefined;
  }, [selectedConvId, selectedConnId, conversationsByConn, searchResults]);

  const groupedSearch = useMemo(() => {
    const groups: { connectionId: string; label: string; items: ConversationSearchResult[] }[] = [];
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

  const openSearchResult = useCallback((r: ConversationSearchResult) => {
    setSelectedConnId(r.connectionId);
    setActiveMatchIds(r.matchedMessageIds);
    setMatchIndex(0);
    setHighlightMessageId(null);
    pendingNavRef.current = true;
    setSelectedConvId(r.conversationId);
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

  const matchCountLabel = (n: number) =>
    n > 200 ? '共 200+ 条匹配' : `共 ${n} 条匹配`;

  const clearSearch = () => {
    setSearchInput('');
    setDebouncedQuery('');
    setSearchResults([]);
    setActiveMatchIds([]);
    setMatchIndex(0);
    setHighlightMessageId(null);
    pendingNavRef.current = false;
  };

  return (
    <Modal open={open} onClose={onClose} title="聊天历史记录" size="xl">
      <div className="flex flex-col flex-1 overflow-hidden">
        {/* Search bar */}
        <div className="px-3 pt-1 pb-2 border-b border-zinc-800 flex-shrink-0">
          <div className="relative">
            <svg
              className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none"
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
              className="w-full rounded-lg bg-zinc-800 border border-zinc-700 pl-9 pr-8 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500"
            />
            {searchInput && (
              <button
                type="button"
                onClick={clearSearch}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-zinc-500 hover:text-zinc-200"
                title="清除"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Left sidebar */}
          <div className="w-64 flex-shrink-0 bg-zinc-800 border-r border-zinc-700 overflow-y-auto p-2 space-y-1">
            {isSearching ? (
              <>
                {loadingSearch && (
                  <div className="p-4 text-sm text-zinc-500">搜索中…</div>
                )}
                {!loadingSearch && searchResults.length === 0 && (
                  <div className="p-4 text-sm text-zinc-500">没有找到匹配的聊天记录</div>
                )}
                {!loadingSearch &&
                  groupedSearch.map((group) => (
                    <div key={group.connectionId} className="space-y-1 mb-2">
                      <div className="px-3 py-1 text-xs font-medium text-zinc-500 truncate">
                        {group.label}
                      </div>
                      {group.items.map((r) => (
                        <button
                          key={r.conversationId}
                          type="button"
                          className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                            selectedConvId === r.conversationId
                              ? 'bg-zinc-700 text-zinc-100'
                              : 'text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
                          }`}
                          onClick={() => openSearchResult(r)}
                        >
                          <div className="truncate font-medium">{r.title}</div>
                          <div className="text-xs text-zinc-500 mt-0.5 line-clamp-2 break-words">
                            {r.matchedSnippet}
                          </div>
                          <div className="text-xs text-indigo-400/80 mt-0.5">
                            {matchCountLabel(r.matchCount)}
                          </div>
                        </button>
                      ))}
                    </div>
                  ))}
              </>
            ) : (
              <>
                {loadingConvs && (
                  <div className="p-4 text-sm text-zinc-500">加载中...</div>
                )}
                {!loadingConvs && connections.length === 0 && (
                  <div className="p-4 text-sm text-zinc-500">暂无连接记录</div>
                )}
                {connections.map((conn) => {
                  const convs = conversationsByConn[conn.id] || [];
                  const isSelected = selectedConnId === conn.id;
                  return (
                    <div key={conn.id} className="space-y-1">
                      <button
                        type="button"
                        className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                          isSelected
                            ? 'bg-zinc-700 text-zinc-100'
                            : 'text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
                        }`}
                        onClick={() => {
                          setSelectedConnId(isSelected ? null : conn.id);
                          setSelectedConvId(null);
                          setMessages([]);
                          setActiveMatchIds([]);
                          setHighlightMessageId(null);
                        }}
                      >
                        <div className="flex items-center justify-between">
                          <span className="truncate">{connLabel(conn)}</span>
                          <span className="ml-2 text-xs text-zinc-500 flex-shrink-0">{convs.length}</span>
                        </div>
                      </button>
                      {isSelected && convs.length > 0 && (
                        <div className="space-y-2 pl-2 mt-1">
                          {groupConversationsByDate(convs).map((group) => (
                            <div key={group.key} className="space-y-1">
                              <div className="px-2 py-0.5 text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">
                                {group.label}
                              </div>
                              {group.items.map((conv) => (
                                <div
                                  key={conv.id}
                                  className={`group/conv flex items-center justify-between px-2 py-1.5 rounded-lg text-sm transition-colors ${
                                    selectedConvId === conv.id
                                      ? 'bg-zinc-700 text-zinc-100 ring-1 ring-zinc-600'
                                      : 'text-zinc-400 hover:bg-zinc-700/60 hover:text-zinc-200'
                                  }`}
                                >
                                  <button
                                    type="button"
                                    className="flex-1 text-left min-w-0 flex items-center justify-between gap-2"
                                    onClick={() => {
                                      setActiveMatchIds([]);
                                      setHighlightMessageId(null);
                                      setSelectedConvId(conv.id === selectedConvId ? null : conv.id);
                                    }}
                                  >
                                    <div className="min-w-0 flex-1">
                                      <div className="truncate font-medium">{conv.title}</div>
                                      <div className="text-[11px] text-zinc-500 mt-0.5">
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
                                    onClick={(e) => handleRenameInModal(e, conv.id, conv.title)}
                                    className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-600 transition-colors opacity-0 group-hover/conv:opacity-100 flex-shrink-0"
                                    title="重命名会话"
                                  >
                                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                                      />
                                    </svg>
                                  </button>
                                </div>
                              ))}
                            </div>
                          ))}
                        </div>
                      )}
                      {isSelected && convs.length === 0 && (
                        <div className="pl-5 pr-3 py-2 text-xs text-zinc-600">该连接暂无会话</div>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </div>

          {/* Right content */}
          <div className="flex-1 flex flex-col bg-zinc-900 overflow-hidden">
            {selectedConv && (
              <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 flex-shrink-0">
                <div className="min-w-0">
                  <h4 className="text-sm font-semibold text-zinc-100 truncate">{selectedConv.title}</h4>
                  {selectedConn && (
                    <p className="text-xs text-zinc-500 truncate">{connLabel(selectedConn)}</p>
                  )}
                </div>
                <span className="text-xs text-zinc-600 flex-shrink-0 ml-3">
                  {new Date(selectedConv.updatedAt).toLocaleString()}
                </span>
              </div>
            )}

            {activeMatchIds.length > 0 && selectedConvId && (
              <div className="flex items-center justify-center gap-3 px-4 py-1.5 border-b border-indigo-500/15 bg-indigo-500/5 sticky top-0 z-10 flex-shrink-0 text-xs text-zinc-300">
                <span className="text-indigo-300/90">
                  匹配到 {activeMatchIds.length}
                  {activeMatchIds.length >= 200 ? '+' : ''} 条结果
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={matchIndex <= 0}
                    onClick={() => goMatch(-1)}
                    className="px-1.5 py-0.5 rounded text-indigo-200/80 hover:bg-indigo-500/15 disabled:opacity-30 disabled:cursor-not-allowed"
                    title="上一条"
                  >
                    ◀
                  </button>
                  <span className="tabular-nums text-zinc-400 min-w-[3rem] text-center">
                    {matchIndex + 1}/{activeMatchIds.length}
                  </span>
                  <button
                    type="button"
                    disabled={matchIndex >= activeMatchIds.length - 1}
                    onClick={() => goMatch(1)}
                    className="px-1.5 py-0.5 rounded text-indigo-200/80 hover:bg-indigo-500/15 disabled:opacity-30 disabled:cursor-not-allowed"
                    title="下一条"
                  >
                    ▶
                  </button>
                </div>
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-4 space-y-1">
              {loadingMsgs && (
                <div className="p-4 text-sm text-zinc-500">加载消息...</div>
              )}
              {!loadingMsgs && !selectedConvId && (
                <div className="flex items-center justify-center h-full text-sm text-zinc-500">
                  请选择一个会话查看消息
                </div>
              )}
              {!loadingMsgs && selectedConvId && messages.length === 0 && (
                <div className="flex items-center justify-center h-full text-sm text-zinc-500">
                  该会话暂无消息
                </div>
              )}
              {!loadingMsgs && messages.length > 0 && (
                <AgentMessageList
                  messages={messages}
                  isThinking={false}
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
