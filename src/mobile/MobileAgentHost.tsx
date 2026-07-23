import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { Trash2 } from 'lucide-react';
import { useAgent } from '@/hooks/useAgent';
import { useAnimatedPresence } from '@/hooks/useAnimatedPresence';
import { useConnectionStore } from '@/stores/connectionStore';
import { useSessionStore } from '@/stores/sessionStore';
import { AGENT_MODES } from '@/lib/constants';
import type { AgentMessage, AgentMode, QuestionAnswer } from '@/lib/types';
import AgentMessageList from '@/components/agent/AgentMessageList';
import PlanList from '@/components/agent/PlanList';
import MobileApprovalSheet from './MobileApprovalSheet';
import MobileQuestionSheet from './MobileQuestionSheet';
import MobileChatHistorySheet from './MobileChatHistorySheet';
import MobileSheet from './ui/MobileSheet';
import {
  agentEmptyStateReason,
  canSendAgentPrompt,
  resolveAgentIds,
  type AgentEmptyStateReason,
} from './agentUi';
import {
  isNearBottom,
  shouldAutoScroll,
  shouldShowScrollToBottomFab,
} from './agentScroll';
import { resolveSessionDisplayName, sessionStatusLabel } from './sessionUi';

const NEAR_BOTTOM_THRESHOLD_PX = 80;

interface MobileAgentHostProps {
  /** When false, host stays mounted but hidden (tab keep-alive). */
  visible?: boolean;
}

const EMPTY_STATE_COPY: Record<
  Exclude<AgentEmptyStateReason, 'ready'>,
  { title: string; body: string }
> = {
  'no-session': {
    title: '未选择会话',
    body: '请先在终端页连接 SSH 服务器。',
  },
  connecting: {
    title: '正在连接…',
    body: '连接完成后可使用智能助手。',
  },
  disconnected: {
    title: '连接已断开',
    body: '请在终端页重新连接后再使用。',
  },
  error: {
    title: '连接失败',
    body: '请在终端页检查连接后重试。',
  },
  'no-config': {
    title: '无法使用助手',
    body: '当前会话未绑定已保存连接，请从连接列表重新连接。',
  },
};

export default function MobileAgentHost({
  visible = true,
}: MobileAgentHostProps) {
  const activeSession = useSessionStore((s) => {
    const id = s.activeSessionId;
    return id ? (s.sessions[id] ?? null) : null;
  });
  const connections = useConnectionStore((s) => s.connections);
  const ids = resolveAgentIds(activeSession);
  /** Connected + bound saved connection — required for conversation/task IPC. */
  const canInteract = !!ids && activeSession?.status === 'connected';
  const emptyReason = agentEmptyStateReason(activeSession);

  const {
    messages,
    sendPrompt,
    stopActiveTask,
    mode,
    setMode,
    inputDraft,
    setInputDraft,
    isRunning,
    pendingApproval,
    pendingQuestion,
    approveCurrent,
    rejectCurrent,
    submitAnswer,
    conversations,
    activeConversationId,
    newConversation,
    switchConversation,
    deleteConversation,
    syncActiveToConnection,
    rollbackToMessage,
  } = useAgent();

  const [modeOpen, setModeOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const modePresence = useAnimatedPresence(modeOpen);
  const historyPresence = useAnimatedPresence(historyOpen);
  /** 未连接时的只读历史浏览面板（对齐桌面 AgentPanel 的 ChatHistoryModal 分支） */
  const [historyBrowserOpen, setHistoryBrowserOpen] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [rollbackHint, setRollbackHint] = useState<string | null>(null);
  const [nearBottom, setNearBottom] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sendingRef = useRef(false);
  const lastScrolledMessageRef = useRef<string | null>(null);
  const rollbackHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const nearBottomRef = useRef(true);
  const userJustSentRef = useRef(false);
  const prevVisibleRef = useRef(visible);
  const messageCountAtHideRef = useRef(0);

  const sessionConversations = useMemo(
    () =>
      Object.values(conversations).filter(
        (c) => ids?.configId != null && c.connectionId === ids.configId,
      ),
    [conversations, ids?.configId],
  );

  const currentModeInfo =
    AGENT_MODES.find((m) => m.value === mode) ?? AGENT_MODES[1];
  const isThinking = useMemo(
    () => messages.some((m) => m.role === 'assistant' && m.isThinking),
    [messages],
  );

  useEffect(() => {
    if (!ids?.configId) return;
    void syncActiveToConnection(ids.configId);
  }, [ids?.configId, syncActiveToConnection]);

  const lastMessage = messages[messages.length - 1];
  const lastMessageSize =
    (lastMessage?.content.length ?? 0) +
    (lastMessage?.reasoningContent?.length ?? 0);

  const measureNearBottom = useCallback((): boolean => {
    const el = scrollContainerRef.current;
    if (!el) return true;
    return isNearBottom(
      el.scrollTop,
      el.clientHeight,
      el.scrollHeight,
      NEAR_BOTTOM_THRESHOLD_PX,
    );
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = scrollContainerRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior });
    } else {
      messagesEndRef.current?.scrollIntoView({ behavior, block: 'end' });
    }
    nearBottomRef.current = true;
    setNearBottom(true);
  }, []);

  const handleScroll = useCallback(() => {
    const near = measureNearBottom();
    nearBottomRef.current = near;
    setNearBottom(near);
  }, [measureNearBottom]);

  // Stream: only pin when sticky zone or user just sent (don't yank while reading up).
  useEffect(() => {
    if (!lastMessage || !canInteract) return;
    if (!shouldAutoScroll(nearBottomRef.current, userJustSentRef.current))
      return;
    const isNew = lastScrolledMessageRef.current !== lastMessage.id;
    lastScrolledMessageRef.current = lastMessage.id;
    scrollToBottom(isNew ? 'smooth' : 'auto');
    userJustSentRef.current = false;
  }, [lastMessage, lastMessageSize, canInteract, scrollToBottom]);

  // Tab become visible: scrollIntoView while hidden is useless — re-pin once if sticky/empty→msgs.
  useEffect(() => {
    const wasVisible = prevVisibleRef.current;
    prevVisibleRef.current = visible;
    if (!visible) {
      // Snapshot only on hide transition; do not overwrite while messages stream off-tab.
      if (wasVisible) messageCountAtHideRef.current = messages.length;
      return;
    }
    if (wasVisible) return;
    const emptyToMessages =
      messageCountAtHideRef.current === 0 && messages.length > 0;
    if (!nearBottomRef.current && !emptyToMessages) return;
    // rAF: layout may still be settling after un-hide
    requestAnimationFrame(() => {
      scrollToBottom('auto');
    });
  }, [visible, messages.length, scrollToBottom]);

  // Container resize (IME open/close, input growth, plan panel): keep pinned
  // to bottom when in the sticky zone, otherwise the newest content slides
  // under the keyboard. Non-sticky users keep their reading position for free
  // (scrollTop is measured from the top, so the top line stays put).
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (nearBottomRef.current) {
        scrollToBottom('auto');
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollToBottom]);

  const handleSend = useCallback(async () => {
    if (isRunning || sendingRef.current) return;
    if (!canSendAgentPrompt(activeSession, isRunning, inputDraft)) return;
    if (!ids) return;
    const prompt = inputDraft.trim();
    sendingRef.current = true;
    userJustSentRef.current = true;
    setInputDraft('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    try {
      await sendPrompt(ids.sessionId, prompt, ids.configId);
    } catch (err) {
      console.error('Failed to start task:', err);
      setInputDraft(prompt);
      userJustSentRef.current = false;
    } finally {
      sendingRef.current = false;
    }
  }, [activeSession, ids, inputDraft, isRunning, sendPrompt, setInputDraft]);

  const handleStop = useCallback(() => {
    void stopActiveTask();
  }, [stopActiveTask]);

  const handleApprove = useCallback(async () => {
    if (pendingApproval) {
      await approveCurrent(pendingApproval.toolCallId);
    }
  }, [approveCurrent, pendingApproval]);

  const handleReject = useCallback(async () => {
    if (pendingApproval) {
      await rejectCurrent(pendingApproval.toolCallId);
    }
  }, [pendingApproval, rejectCurrent]);

  const handleSubmitQuestion = useCallback(
    async (questionId: string, answers: QuestionAnswer[]) => {
      await submitAnswer(questionId, answers);
    },
    [submitAnswer],
  );

  const handleCancelQuestion = useCallback(async () => {
    if (!pendingQuestion) return;
    const answers: QuestionAnswer[] = (pendingQuestion.questions ?? []).map(
      () => ({
        selected: [],
        custom: '',
      }),
    );
    await submitAnswer(pendingQuestion.questionId, answers);
  }, [pendingQuestion, submitAnswer]);

  const handleNewConversation = useCallback(async () => {
    if (!canInteract || !ids) return;
    try {
      await newConversation(ids.sessionId, ids.configId);
      setHistoryOpen(false);
    } catch (err) {
      console.error('Failed to create conversation:', err);
    }
  }, [canInteract, ids, newConversation]);

  const handleSelectConversation = useCallback(
    async (conversationId: string) => {
      try {
        await switchConversation(conversationId);
        setHistoryOpen(false);
      } catch (err) {
        console.error('Failed to switch conversation:', err);
      }
    },
    [switchConversation],
  );

  const handleDeleteConversation = useCallback(async () => {
    if (!deleteTargetId) return;
    const id = deleteTargetId;
    setDeleteTargetId(null);
    try {
      await deleteConversation(id);
    } catch (err) {
      console.error('Failed to delete conversation:', err);
    }
  }, [deleteTargetId, deleteConversation]);

  const deleteTargetTitle = deleteTargetId
    ? (conversations[deleteTargetId]?.title ?? '该会话')
    : '';

  const showRollbackHint = useCallback((text: string) => {
    setRollbackHint(text);
    if (rollbackHintTimerRef.current)
      clearTimeout(rollbackHintTimerRef.current);
    rollbackHintTimerRef.current = setTimeout(
      () => setRollbackHint(null),
      3200,
    );
  }, []);

  useEffect(() => {
    return () => {
      if (rollbackHintTimerRef.current)
        clearTimeout(rollbackHintTimerRef.current);
    };
  }, []);

  const handleRollbackMessage = useCallback(
    async (message: AgentMessage) => {
      if (!activeConversationId || isRunning) return;
      try {
        const result = await rollbackToMessage(
          activeConversationId,
          message.id,
        );
        setInputDraft(result.prompt);
        showRollbackHint(`已撤回 ${result.removedCount} 条消息`);
        requestAnimationFrame(() => {
          if (inputRef.current) {
            inputRef.current.style.height = 'auto';
            inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 120)}px`;
            inputRef.current.focus();
          }
        });
      } catch (err) {
        console.error('Failed to rollback message:', err);
        showRollbackHint('撤回失败');
      }
    },
    [
      activeConversationId,
      isRunning,
      rollbackToMessage,
      setInputDraft,
      showRollbackHint,
    ],
  );

  const handleCopyMessage = useCallback(async (message: AgentMessage) => {
    try {
      await writeText(message.content);
    } catch (err) {
      console.error('Failed to copy message:', err);
    }
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputDraft(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const sendEnabled =
    !!ids && canSendAgentPrompt(activeSession, isRunning, inputDraft);
  const hostLabel =
    resolveSessionDisplayName(activeSession, connections) || '智能助手';
  const statusText = activeSession
    ? sessionStatusLabel(activeSession.status)
    : '无会话';

  return (
    <div
      className="relative flex h-full min-h-0 flex-col bg-zinc-950"
      data-region="mobile-agent"
    >
      {pendingApproval && (
        <MobileApprovalSheet
          toolCall={{
            id: pendingApproval.toolCallId,
            name: pendingApproval.toolName,
            arguments: pendingApproval.arguments,
            riskLevel: pendingApproval.riskLevel,
            reasons: pendingApproval.reasons,
            metadata: pendingApproval.metadata,
          }}
          open={!!pendingApproval}
          onApprove={() => void handleApprove()}
          onReject={() => void handleReject()}
        />
      )}

      <header
        className="flex flex-shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-950 px-3 py-2"
        style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top, 0px))' }}
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-zinc-100">
            {hostLabel}
          </div>
          <div
            className={`text-[11px] ${
              activeSession?.status === 'connected'
                ? 'text-emerald-400'
                : activeSession?.status === 'connecting'
                  ? 'text-amber-400'
                  : activeSession?.status === 'error'
                    ? 'text-red-400'
                    : 'text-zinc-500'
            }`}
          >
            {statusText}
            {isRunning ? ' · 运行中' : ''}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void handleNewConversation()}
          disabled={!canInteract || !ids}
          className="rounded-lg bg-green-600 px-2.5 py-1.5 text-xs font-medium text-white transition-transform duration-100 active:scale-95 active:bg-green-500 disabled:opacity-40"
        >
          新对话
        </button>
        <button
          type="button"
          onClick={() => {
            // 对齐桌面 AgentPanel：已连接切会话，未连接只读浏览全部历史
            if (canInteract) {
              setHistoryOpen((v) => !v);
            } else {
              setHistoryBrowserOpen(true);
            }
          }}
          className="rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-200 transition-transform duration-100 active:scale-95 active:bg-zinc-700"
        >
          历史
        </button>
      </header>

      {pendingApproval && (
        <div className="flex-shrink-0 border-b border-amber-700/50 bg-amber-950/50 px-3 py-2 text-xs text-amber-100">
          需要批准操作：{pendingApproval.toolName}
        </div>
      )}
      {rollbackHint && (
        <div className="flex-shrink-0 border-b border-zinc-700 bg-zinc-900 px-3 py-1.5 text-center text-xs text-zinc-300">
          {rollbackHint}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollContainerRef}
          className="h-full min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain p-3"
          onScroll={handleScroll}
        >
          {emptyReason !== 'ready' && (
            <div className="mt-10 text-center text-sm text-zinc-500">
              <p className="font-medium text-zinc-400">
                {EMPTY_STATE_COPY[emptyReason].title}
              </p>
              <p className="mt-1">{EMPTY_STATE_COPY[emptyReason].body}</p>
            </div>
          )}
          {emptyReason === 'ready' && messages.length === 0 && (
            <div className="mt-10 text-center text-sm text-zinc-500">
              <p className="font-medium text-zinc-400">
                {activeConversationId ? '暂无消息' : '暂无会话'}
              </p>
              <p className="mt-1">
                {activeConversationId
                  ? '描述您想做的事，智能助手会协助您。'
                  : '点击「新对话」开始，或直接输入发送。'}
              </p>
            </div>
          )}
          {canInteract && (
            <AgentMessageList
              messages={messages}
              isThinking={isThinking}
              isRunning={isRunning}
              messagesEndRef={messagesEndRef}
              onRollback={(m) => void handleRollbackMessage(m)}
              onCopy={(m) => void handleCopyMessage(m)}
              alwaysShowActions
            />
          )}
        </div>
        {shouldShowScrollToBottomFab(nearBottom, messages.length > 0) && (
          <button
            type="button"
            onClick={() => scrollToBottom('smooth')}
            className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-zinc-600 bg-zinc-800/95 px-3 py-1.5 text-xs font-medium text-zinc-100 shadow-lg backdrop-blur-sm active:bg-zinc-700"
          >
            回到底部
          </button>
        )}
      </div>

      <PlanList />

      {historyPresence.mounted && canInteract && (
        <>
          <div
            className={`absolute inset-0 z-20 bg-black/40 ${
              historyPresence.phase === 'exit'
                ? 'mobile-backdrop-exit'
                : 'mobile-backdrop-enter'
            }`}
            onClick={() => setHistoryOpen(false)}
          />
          <div
            onAnimationEnd={historyPresence.onAnimationEnd}
            className={`absolute inset-x-0 bottom-0 z-30 max-h-[55%] overflow-y-auto rounded-t-2xl border-t border-zinc-700 bg-zinc-900 p-3 shadow-2xl ${
              historyPresence.phase === 'exit'
                ? 'mobile-sheet-exit'
                : 'mobile-sheet-enter'
            }`}
          >
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-100">历史会话</h3>
              <button
                type="button"
                onClick={() => setHistoryOpen(false)}
                className="text-xs text-zinc-400"
              >
                关闭
              </button>
            </div>
            {sessionConversations.length === 0 ? (
              <p className="py-6 text-center text-sm text-zinc-500">
                暂无历史会话
              </p>
            ) : (
              <ul className="space-y-1">
                {sessionConversations.map((conv) => {
                  const active = conv.id === activeConversationId;
                  return (
                    <li
                      key={conv.id}
                      className={`flex items-center gap-1 rounded-lg ${
                        active
                          ? 'bg-green-600/20 text-green-200'
                          : 'bg-zinc-800/60 text-zinc-300'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => void handleSelectConversation(conv.id)}
                        className="min-w-0 flex-1 px-3 py-2.5 text-left text-sm active:opacity-80"
                      >
                        <div className="truncate font-medium">{conv.title}</div>
                        <div className="mt-0.5 text-[11px] text-zinc-500">
                          {new Date(conv.updatedAt).toLocaleString()}
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTargetId(conv.id)}
                        className="mr-1.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-zinc-500 active:bg-zinc-800 active:text-red-400"
                        aria-label={`删除 ${conv.title}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}

      <MobileSheet
        open={deleteTargetId != null}
        onClose={() => setDeleteTargetId(null)}
        title="确认删除"
      >
        <div className="flex flex-col gap-2 px-4 pb-4">
          <p className="pb-1 text-sm text-zinc-400">
            删除会话「{deleteTargetTitle}」？此操作不可撤销。
          </p>
          <button
            type="button"
            onClick={() => void handleDeleteConversation()}
            className="rounded-xl bg-red-600 px-4 py-3 text-sm font-medium text-white active:bg-red-500"
          >
            删除
          </button>
          <button
            type="button"
            onClick={() => setDeleteTargetId(null)}
            className="rounded-xl px-4 py-3 text-sm text-zinc-400 active:bg-zinc-800"
          >
            取消
          </button>
        </div>
      </MobileSheet>

      <MobileChatHistorySheet
        open={historyBrowserOpen}
        onClose={() => setHistoryBrowserOpen(false)}
      />

      {pendingQuestion ? (
        <MobileQuestionSheet
          questionId={pendingQuestion.questionId}
          questions={pendingQuestion.questions}
          onSubmit={handleSubmitQuestion}
          onCancel={() => void handleCancelQuestion()}
        />
      ) : (
        <div className="flex-shrink-0 border-t border-zinc-800 p-3">
          <div className="agent-input flex items-end gap-2 rounded-xl border border-zinc-700 bg-zinc-900 focus-within:border-green-500">
            <div className="relative flex-shrink-0 self-center pl-1">
              <button
                type="button"
                onClick={() => setModeOpen((v) => !v)}
                className="rounded-lg px-2 py-2 text-xs font-semibold tracking-wider text-zinc-300 active:bg-zinc-800"
                title={currentModeInfo.description}
              >
                {currentModeInfo.label}
              </button>
              {modeOpen && (
                <div
                  className="fixed inset-0 z-20"
                  onClick={() => setModeOpen(false)}
                  aria-hidden
                />
              )}
              {modePresence.mounted && (
                <div
                  onAnimationEnd={modePresence.onAnimationEnd}
                  className={`absolute bottom-full left-0 z-30 mb-2 w-56 rounded-xl border border-zinc-700 bg-zinc-800 py-1 shadow-2xl ${
                    modePresence.phase === 'exit'
                      ? 'mobile-popover-exit'
                      : 'mobile-popover-enter'
                  }`}
                >
                  {AGENT_MODES.map((m) => {
                    const active = m.value === mode;
                    return (
                      <button
                        key={m.value}
                        type="button"
                        onClick={() => {
                          setMode(m.value as AgentMode);
                          setModeOpen(false);
                        }}
                        className={`w-full px-3 py-2 text-left text-sm ${
                          active
                            ? 'bg-green-600/20 text-green-200'
                            : 'text-zinc-200 active:bg-zinc-700'
                        }`}
                      >
                        <div className="font-bold tracking-wider">
                          {m.label}
                        </div>
                        <div className="mt-0.5 text-[11px] text-zinc-400">
                          {m.description}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="w-px self-stretch bg-zinc-700 my-2" />
            <textarea
              ref={inputRef}
              rows={1}
              value={inputDraft}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder={
                !canInteract
                  ? '请先连接服务器…'
                  : !ids
                    ? '请从连接列表重新连接…'
                    : '描述您想要做的事情…'
              }
              disabled={!canInteract || !ids}
              className="min-h-[2.5rem] max-h-[7.5rem] min-w-0 flex-1 resize-none bg-transparent px-2 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none focus:outline-none focus-visible:outline-none disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => (isRunning ? handleStop() : void handleSend())}
              disabled={!isRunning && !sendEnabled}
              className={`m-1.5 flex-shrink-0 self-center rounded-lg px-3 py-2 text-xs font-medium text-white disabled:opacity-40 ${
                isRunning
                  ? 'bg-red-600 active:bg-red-500'
                  : 'bg-green-600 active:bg-green-500'
              }`}
            >
              {isRunning ? '停止' : '发送'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
