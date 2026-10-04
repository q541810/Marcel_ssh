import { useEffect, useMemo, useRef, useState } from "react";
import { Pin } from "lucide-react";
import type { AnimatedPresence } from "@/hooks/useAnimatedPresence";
import { groupConversationsWithPinned } from "@/lib/dateGrouping";
import { getErrorMessage } from "@/lib/errors";
import { getConversationAgentStatus } from "@/stores/agentStatusSelectors";
import { AgentStatusIndicator } from "../AgentStatusIndicator";
import type { AgentConversation, AgentTask } from "@/lib/types";

type AgentHistoryDrawerProps = {
  presence: AnimatedPresence;
  onClose: () => void;
  /** 本会话主对话列表（子agent对话不在列表展示：只通过主对话的 task 卡片进入/返回）。 */
  sessionConversations: AgentConversation[];
  activeConversationId: string | null;
  tasks: Record<string, AgentTask>;
  unreadCompletedConversations: string[];
  onSelect: (conversationId: string) => Promise<void>;
  onDelete: (conversationId: string) => Promise<void>;
  onPin: (conversationId: string, pinned: boolean) => Promise<void>;
  onRename: (conversationId: string, title: string) => Promise<void>;
};

/** 历史会话抽屉：日期分组列表 + 行内重命名 / 置顶 / 删除。 */
export function AgentHistoryDrawer({
  presence,
  onClose,
  sessionConversations,
  activeConversationId,
  tasks,
  unreadCompletedConversations,
  onSelect,
  onDelete,
  onPin,
  onRename,
}: AgentHistoryDrawerProps) {
  const [editingConvId, setEditingConvId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  const startRenameConversation = (
    e: React.MouseEvent,
    convId: string,
    currentTitle: string,
  ) => {
    e.stopPropagation();
    setEditingConvId(convId);
    setEditingTitle(currentTitle);
  };

  const handleSaveRename = async () => {
    if (!editingConvId) return;
    const trimmed = editingTitle.trim();
    if (trimmed) {
      try {
        await onRename(editingConvId, trimmed);
      } catch (err) {
        console.error("Failed to rename conversation:", err);
      }
    }
    setEditingConvId(null);
    setEditingTitle("");
  };

  const handleCancelRename = () => {
    setEditingConvId(null);
    setEditingTitle("");
  };

  useEffect(() => {
    if (editingConvId) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingConvId]);

  const groupedSessionConversations = useMemo(
    () => groupConversationsWithPinned(sessionConversations),
    [sessionConversations],
  );

  const handleDeleteConversation = async (
    e: React.MouseEvent,
    conversationId: string,
  ) => {
    e.stopPropagation();
    try {
      await onDelete(conversationId);
    } catch (err) {
      console.error("Failed to delete conversation:", err);
    }
  };

  return (
    <>
      <div
        className={`absolute inset-0 bg-black/40 z-20 ${
          presence.phase === "exit"
            ? "animate-fadeOut"
            : "animate-fadeIn"
        }`}
        onClick={onClose}
      />
      <div
        onAnimationEnd={presence.onAnimationEnd}
        className={`absolute top-0 right-0 h-full w-72 bg-zinc-950 border-l border-zinc-800 z-30 flex flex-col shadow-2xl ${
          presence.phase === "exit"
            ? "animate-slideOutRight"
            : "animate-slideInRight"
        }`}
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
          <h3 className="text-sm font-semibold text-zinc-200">历史会话</h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 transition-colors"
          >
            <svg
              className="w-4 h-4"
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
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-3">
          {sessionConversations.length === 0 && (
            <div className="text-center text-zinc-500 text-sm mt-8">
              <p>暂无历史会话</p>
            </div>
          )}
          {groupedSessionConversations.map((group) => (
            <div key={group.key} className="space-y-1">
              <div className="px-2 py-1 text-[11px] font-semibold text-zinc-500 tracking-wider uppercase">
                {group.label}
              </div>
              {group.items.map((conv) => {
                const isActive = conv.id === activeConversationId;
                const isEditing = editingConvId === conv.id;
                return (
                  <div
                    key={conv.id}
                    className={`group flex items-center gap-1 px-2 py-1.5 rounded-lg text-sm transition-colors ${
                      isActive
                        ? "bg-zinc-800 text-zinc-100 ring-1 ring-zinc-700/50"
                        : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
                    }`}
                  >
                    {isEditing ? (
                      <div className="flex-1 flex items-center gap-1 min-w-0">
                        <input
                          ref={editInputRef}
                          type="text"
                          value={editingTitle}
                          onChange={(e) => setEditingTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void handleSaveRename();
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              handleCancelRename();
                            }
                          }}
                          className="flex-1 min-w-0 px-1.5 py-0.5 text-xs bg-zinc-900 border border-indigo-500 rounded text-zinc-100 focus:outline-none"
                          placeholder="会话名称"
                        />
                        <button
                          type="button"
                          onClick={() => void handleSaveRename()}
                          className="p-1 rounded text-emerald-400 hover:bg-zinc-700 transition-colors flex-shrink-0"
                          title="确认"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          onClick={handleCancelRename}
                          className="p-1 rounded text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 transition-colors flex-shrink-0"
                          title="取消"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    ) : (
                      <>
                        <button
                          onClick={() => onSelect(conv.id)}
                          className="flex-1 text-left min-w-0 flex items-center justify-between gap-2"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium leading-snug">{conv.title}</div>
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
                          onClick={(e) => {
                            e.stopPropagation();
                            // 后置失败就原地不动 —— 必须接住，否则是未处理拒绝
                            //（沿用重命名那一套：失败 console.error，图标不变）
                            onPin(conv.id, !conv.pinned).catch((err) => {
                              console.error('Failed to toggle pin:', getErrorMessage(err));
                            });
                          }}
                          className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700/80 transition-colors flex-shrink-0 opacity-0 group-hover:opacity-100"
                          title={conv.pinned ? "取消置顶" : "置顶会话"}
                          aria-label={conv.pinned ? "取消置顶" : "置顶会话"}
                        >
                          <Pin className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={(e) => startRenameConversation(e, conv.id, conv.title)}
                          className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700/80 transition-colors flex-shrink-0 opacity-0 group-hover:opacity-100"
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
                        <button
                          onClick={(e) => handleDeleteConversation(e, conv.id)}
                          className="p-1 rounded text-zinc-500 hover:text-red-400 hover:bg-zinc-700/80 transition-colors flex-shrink-0 opacity-0 group-hover:opacity-100"
                          title="删除会话"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                            />
                          </svg>
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
