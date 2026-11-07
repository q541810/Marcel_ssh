import { Check, ChevronLeft, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArchiveRestore, Pin, Trash2 } from "lucide-react";
import type { AnimatedPresence } from "@/hooks/useAnimatedPresence";
import { groupConversationsWithPinned } from "@/lib/dateGrouping";
import { getErrorMessage } from "@/lib/errors";
import { getConversationAgentStatus } from "@/stores/agentStatusSelectors";
import { AgentStatusIndicator } from "../AgentStatusIndicator";
import { ForkMark } from "../ForkMark";
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
  /** 归档会话：可恢复，**免二次确认**（真正的不可逆操作是「永久删除」）。 */
  onArchive: (conversationId: string) => Promise<void>;
  onPin: (conversationId: string, pinned: boolean) => Promise<void>;
  onRename: (conversationId: string, title: string) => Promise<void>;
  /** 本连接的归档会话（归档视图按需加载）。 */
  archivedConversations: AgentConversation[];
  archivedLoading: boolean;
  onLoadArchived: () => Promise<void>;
  onUnarchive: (conversationId: string) => Promise<void>;
  /** 永久删除：只允许在归档视图里做（二次确认在组件内）。 */
  onDeletePermanently: (conversationId: string) => Promise<void>;
};

type DrawerMode = "active" | "archived";

/** 历史会话抽屉：日期分组列表 + 行内重命名 / 置顶 / 归档；归档视图里恢复 / 永久删除。 */
export function AgentHistoryDrawer({
  presence,
  onClose,
  sessionConversations,
  activeConversationId,
  tasks,
  unreadCompletedConversations,
  onSelect,
  onArchive,
  onPin,
  onRename,
  archivedConversations,
  archivedLoading,
  onLoadArchived,
  onUnarchive,
  onDeletePermanently,
}: AgentHistoryDrawerProps) {
  const [editingConvId, setEditingConvId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [mode, setMode] = useState<DrawerMode>("active");
  // 切视图时的入场方向；首次打开抽屉没有切换，不带动画（整块抽屉自己在滑入）
  const [viewDir, setViewDir] = useState<"push" | "pop" | null>(null);
  const viewEnter =
    viewDir === "push" ? "view-push-enter" : viewDir === "pop" ? "view-pop-enter" : "";
  const switchMode = (next: DrawerMode) => {
    setError(null);
    setViewDir(next === "archived" ? "push" : "pop");
    setMode(next);
  };
  const [error, setError] = useState<string | null>(null);
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

  // 每次进入归档视图都重新拉一次：别的窗口/另一端可能刚归档或恢复了会话。
  useEffect(() => {
    if (mode === "archived") {
      void onLoadArchived();
    }
  }, [mode, onLoadArchived]);

  const groupedSessionConversations = useMemo(
    () => groupConversationsWithPinned(sessionConversations),
    [sessionConversations],
  );

  const handleArchiveConversation = async (
    e: React.MouseEvent,
    conversationId: string,
  ) => {
    e.stopPropagation();
    setError(null);
    try {
      await onArchive(conversationId);
    } catch (err) {
      // 典型失败：会话正在跑任务 / 压缩中 —— 把后端/前端的原话原样展示，
      // 别让用户只看到「归档没生效」却不知道为什么。
      setError(getErrorMessage(err));
    }
  };

  const handleUnarchive = async (
    e: React.MouseEvent,
    conversationId: string,
  ) => {
    e.stopPropagation();
    setError(null);
    try {
      await onUnarchive(conversationId);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const handleDeletePermanently = async (
    e: React.MouseEvent,
    conversationId: string,
  ) => {
    e.stopPropagation();
    // 归档是免确认的，但「永久删除」是不可逆的，必须二次确认。
    if (!window.confirm("永久删除后无法恢复，确定删除这个会话吗？")) return;
    setError(null);
    try {
      await onDeletePermanently(conversationId);
    } catch (err) {
      setError(getErrorMessage(err));
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
        className={`absolute top-0 right-0 h-full w-72 bg-surface-sunken border-l border-edge-subtle z-30 flex flex-col shadow-overlay ${
          presence.phase === "exit"
            ? "animate-slideOutRight"
            : "animate-slideInRight"
        }`}
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-edge-subtle">
          {mode === "archived" ? (
            <button
              type="button"
              key="archived-title"
              onClick={() => switchMode("active")}
              className={`flex items-center gap-1 text-read font-semibold text-fg hover:text-fg ${viewEnter}`}
              title="返回历史会话"
            >
              <ChevronLeft className="w-4 h-4" strokeWidth={1.5} />
              已归档
            </button>
          ) : (
            <h3 key="active-title" className={`text-read font-semibold text-fg ${viewEnter}`}>
              历史会话
            </h3>
          )}
          <div className="flex items-center gap-1">
            {mode === "active" && (
              <button
                type="button"
                onClick={() => switchMode("archived")}
                className="flex items-center gap-1 p-1 rounded text-fg-secondary hover:text-fg hover:bg-state-mid transition-colors"
                title="查看已归档会话"
                aria-label="查看已归档会话"
              >
                <Archive className="w-4 h-4" />
                {archivedConversations.length > 0 && (
                  <span className="text-caption text-fg-tertiary">
                    {archivedConversations.length}
                  </span>
                )}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              title="关闭"
              aria-label="关闭"
              className="p-1 rounded text-fg-secondary hover:text-fg hover:bg-state-mid transition-colors"
            >
              <X className="w-4 h-4" strokeWidth={1.5} />
            </button>
          </div>
        </div>

        {mode === "archived" ? (
          <div key="archived-body" className={`flex-1 overflow-y-auto p-2 space-y-1 ${viewEnter}`}>
            {archivedLoading && archivedConversations.length === 0 && (
              <div className="text-center text-fg-tertiary text-read mt-8">加载中…</div>
            )}
            {!archivedLoading && archivedConversations.length === 0 && (
              <div className="text-center text-fg-tertiary text-read mt-8 px-4">
                <p>暂无归档会话</p>
                <p className="mt-1 text-meta text-fg-disabled">
                  归档不会删除消息，可随时恢复；超过保留期的归档会在启动时自动清理。
                </p>
              </div>
            )}
            {archivedConversations.map((conv) => (
              <div
                key={conv.id}
                className="group flex items-center gap-1 px-2 py-1.5 rounded-lg text-read text-fg hover:bg-state-soft/60"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-fg">{conv.title}</div>
                  <div className="text-caption text-fg-tertiary mt-0.5">
                    归档于{" "}
                    {new Date(conv.archivedAt ?? conv.updatedAt).toLocaleString()}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={(e) => void handleUnarchive(e, conv.id)}
                  className="p-1 rounded text-fg-tertiary hover:text-emerald-300 hover:bg-state-mid/80 transition-colors flex-shrink-0"
                  title="恢复到会话列表"
                  aria-label="恢复会话"
                >
                  <ArchiveRestore className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={(e) => void handleDeletePermanently(e, conv.id)}
                  className="p-1 rounded text-fg-tertiary hover:text-red-400 hover:bg-state-mid/80 transition-colors flex-shrink-0"
                  title="永久删除"
                  aria-label="永久删除会话"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div key="active-body" className={`flex-1 overflow-y-auto p-2 space-y-3 ${viewEnter}`}>
            {sessionConversations.length === 0 && (
              <div className="text-center text-fg-tertiary text-read mt-8">
                <p>暂无历史会话</p>
              </div>
            )}
            {groupedSessionConversations.map((group) => (
              <div key={group.key} className="space-y-1">
                <div className="px-2 py-1 text-caption font-semibold text-fg-tertiary tracking-wider uppercase">
                  {group.label}
                </div>
                {group.items.map((conv) => {
                  const isActive = conv.id === activeConversationId;
                  const isEditing = editingConvId === conv.id;
                  return (
                    <div
                      key={conv.id}
                      className={`group flex items-center gap-1 px-2 py-1.5 rounded-lg text-read transition-colors ${
                        isActive
                          ? "bg-state-selected text-fg ring-1 ring-edge/50"
                          : "text-fg-secondary hover:bg-state-soft/60 hover:text-fg"
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
                            className="flex-1 min-w-0 px-1.5 py-0.5 text-meta bg-surface border border-indigo-500 rounded text-fg focus:outline-none"
                            placeholder="会话名称"
                          />
                          <button
                            type="button"
                            onClick={() => void handleSaveRename()}
                            className="p-1 rounded text-emerald-400 hover:bg-state-mid transition-colors flex-shrink-0"
                            title="确认"
                          >
                            <Check className="w-3.5 h-3.5" strokeWidth={1.5} />
                          </button>
                          <button
                            type="button"
                            onClick={handleCancelRename}
                            className="p-1 rounded text-fg-secondary hover:bg-state-mid hover:text-fg transition-colors flex-shrink-0"
                            title="取消"
                          >
                            <X className="w-3.5 h-3.5" strokeWidth={1.5} />
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
                              <div className="text-caption text-fg-tertiary mt-0.5">
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
                            onClick={(e) => {
                              e.stopPropagation();
                              // 后置失败就原地不动 —— 必须接住，否则是未处理拒绝
                              //（沿用重命名那一套：失败 console.error，图标不变）
                              onPin(conv.id, !conv.pinned).catch((err) => {
                                console.error('Failed to toggle pin:', getErrorMessage(err));
                              });
                            }}
                            className="p-1 rounded text-fg-tertiary hover:text-fg hover:bg-state-mid/80 transition-colors flex-shrink-0 opacity-0 group-hover:opacity-100"
                            title={conv.pinned ? "取消置顶" : "置顶会话"}
                            aria-label={conv.pinned ? "取消置顶" : "置顶会话"}
                          >
                            <Pin className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={(e) => startRenameConversation(e, conv.id, conv.title)}
                            className="p-1 rounded text-fg-tertiary hover:text-fg hover:bg-state-mid/80 transition-colors flex-shrink-0 opacity-0 group-hover:opacity-100"
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
                            onClick={(e) => void handleArchiveConversation(e, conv.id)}
                            className="p-1 rounded text-fg-tertiary hover:text-amber-300 hover:bg-state-mid/80 transition-colors flex-shrink-0 opacity-0 group-hover:opacity-100"
                            title="归档会话（可恢复）"
                            aria-label="归档会话"
                          >
                            <Archive className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="mx-2 mb-2 rounded-lg border border-red-900 bg-red-950/60 px-2 py-1.5 text-meta text-red-300"
          >
            {error}
          </div>
        )}
      </div>
    </>
  );
}
