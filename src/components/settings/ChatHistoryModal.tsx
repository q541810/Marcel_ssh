import { useState, useEffect } from 'react';
import Modal from '@/components/ui/Modal';
import type { SavedConnection, AgentConversation, AgentMessage as AgentMessageType } from '@/lib/types';
import * as tauri from '@/lib/tauri';
import { storedMessageToAgentMessage, clearIntermediateReasoning } from '@/stores/messageConversion';
import { useConnectionStore } from '@/stores/connectionStore';
import AgentMessageList from '@/components/agent/AgentMessageList';

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

  useEffect(() => {
    if (!open) {
      setSelectedConnId(null);
      setSelectedConvId(null);
      setMessages([]);
      setConversationsByConn({});
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const loadAll = async () => {
      setLoadingConvs(true);
      const byConn: Record<string, AgentConversation[]> = {};
      for (const conn of connections) {
        try {
          const convs = await tauri.agentListConversationsByConnection(conn.id);
          byConn[conn.id] = convs;
        } catch { byConn[conn.id] = []; }
      }
      setConversationsByConn(byConn);
      setLoadingConvs(false);
    };
    if (connections.length > 0) loadAll();
  }, [open, connections]);

  useEffect(() => {
    if (!selectedConvId) { setMessages([]); return; }
    const load = async () => {
      setLoadingMsgs(true);
      try {
        const stored = await tauri.agentLoadConversation(selectedConvId);
        const msgs = clearIntermediateReasoning(stored.map(storedMessageToAgentMessage));
        setMessages(msgs);
      } catch { setMessages([]); }
      setLoadingMsgs(false);
    };
    load();
  }, [selectedConvId]);

  const connLabel = (c: SavedConnection) =>
    `${c.name} (${c.host}:${c.port})`;

  const selectedConn = connections.find((c) => c.id === selectedConnId);
  const selectedConv = selectedConnId
    ? (conversationsByConn[selectedConnId] || []).find((c) => c.id === selectedConvId)
    : undefined;

  return (
    <Modal open={open} onClose={onClose} title="聊天历史记录" size="xl">
      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar */}
        <div className="w-64 flex-shrink-0 bg-zinc-800 border-r border-zinc-700 overflow-y-auto p-2 space-y-1">
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
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                    isSelected
                      ? 'bg-zinc-700 text-zinc-100'
                      : 'text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
                  }`}
                  onClick={() => {
                    setSelectedConnId(isSelected ? null : conn.id);
                    setSelectedConvId(null);
                    setMessages([]);
                  }}
                >
                  <div className="flex items-center justify-between">
                    <span className="truncate">{connLabel(conn)}</span>
                    <span className="ml-2 text-xs text-zinc-500 flex-shrink-0">{convs.length}</span>
                  </div>
                </button>
                {isSelected && convs.length > 0 && (
                  <div className="space-y-1 pl-2">
                    {convs.map((conv) => (
                      <button
                        key={conv.id}
                        className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                          selectedConvId === conv.id
                            ? 'bg-zinc-700 text-zinc-100'
                            : 'text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
                        }`}
                        onClick={() => setSelectedConvId(conv.id === selectedConvId ? null : conv.id)}
                      >
                        <div className="truncate font-medium">{conv.title}</div>
                        <div className="text-xs text-zinc-600 mt-0.5">
                          {new Date(conv.updatedAt).toLocaleString()}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
                {isSelected && convs.length === 0 && (
                  <div className="pl-5 pr-3 py-2 text-xs text-zinc-600">该连接暂无会话</div>
                )}
              </div>
            );
          })}
        </div>

        {/* Right content */}
        <div className="flex-1 flex flex-col bg-zinc-900 overflow-hidden">
          {/* Header */}
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
            <AgentMessageList messages={messages} isThinking={false} />
          </div>
        </div>
      </div>
    </Modal>
  );
}
