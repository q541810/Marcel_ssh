import { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { useAgent } from '@/hooks/useAgent';
import { useSessionStore } from '@/stores/sessionStore';
import { AGENT_MODES } from '@/lib/constants';
import type { AgentMode, AgentMessage, QuestionAnswer } from '@/lib/types';
import Button from '@/components/ui/Button';
import AgentMessageList from './AgentMessageList';
import ApprovalDialog from './ApprovalDialog';
import QuestionPanel from './QuestionPanel';
import PlanList from './PlanList';

export default function AgentPanel() {
  const [modeDrawerOpen, setModeDrawerOpen] = useState(false);
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
  const [rollbackNotice, setRollbackNotice] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastScrolledMessageRef = useRef<string | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const rollbackNoticeTimerRef = useRef<number | null>(null);
  const activeSession = useSessionStore((s) => {
    const session = s.activeSessionId ? s.sessions[s.activeSessionId] : null;
    return session ?? null;
  });
  const reconnect = useSessionStore((s) => s.reconnect);
  const activeSessionId = activeSession?.id ?? null;
  const activeConfigId = activeSession?.configId;
  const {
    messages,
    sendPrompt,
    stopActiveTask,
    mode,
    setMode,
    inputDraft: input,
    setInputDraft: setInput,
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
    rollbackToMessage,
  } = useAgent();

  const sessionConversations = useMemo(
    () => Object.values(conversations).filter((c) => c.connectionId === activeConfigId),
    [conversations, activeConfigId],
  );

  const canInteract = activeSession?.status === 'connected';

  const lastMessage = messages[messages.length - 1];
  const lastMessageSize = (lastMessage?.content.length ?? 0) + (lastMessage?.reasoningContent?.length ?? 0);

  useEffect(() => {
    if (!lastMessage || !canInteract) return;
    const isNewMessage = lastScrolledMessageRef.current !== lastMessage.id;
    lastScrolledMessageRef.current = lastMessage.id;
    messagesEndRef.current?.scrollIntoView({ behavior: isNewMessage ? 'smooth' : 'auto', block: 'end' });
  }, [lastMessage, lastMessageSize, canInteract]);

  useEffect(() => {
    if (!modeDrawerOpen) return;
    const handler = (e: MouseEvent) => {
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) {
        setModeDrawerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [modeDrawerOpen]);

  useEffect(() => () => {
    if (rollbackNoticeTimerRef.current !== null) {
      window.clearTimeout(rollbackNoticeTimerRef.current);
    }
  }, []);

  const handleSend = async () => {
    const prompt = input.trim();
    if (!prompt || !canInteract) return;
    setInput('');
    // Reset textarea height after sending
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }
    try {
      await sendPrompt(activeSessionId!, prompt, activeConfigId);
    } catch (err) {
      console.error('Failed to start task:', err);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    resizeInput();
  };

  const resizeInput = () => {
    const textarea = inputRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 96)}px`;
  };

  useLayoutEffect(() => {
    const textarea = inputRef.current;
    if (!textarea || !input) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 96)}px`;
  }, [input]);

  const showRollbackNotice = (removedCount: number) => {
    setRollbackNotice(`已撤回 ${removedCount} 条消息，原消息已放回输入框`);
    if (rollbackNoticeTimerRef.current !== null) {
      window.clearTimeout(rollbackNoticeTimerRef.current);
    }
    rollbackNoticeTimerRef.current = window.setTimeout(() => {
      setRollbackNotice(null);
      rollbackNoticeTimerRef.current = null;
    }, 4200);
  };

  const handleRollbackMessage = async (message: AgentMessage) => {
    if (!activeConversationId || isRunning) return;
    try {
      const result = await rollbackToMessage(activeConversationId, message.id);
      setInput(result.prompt);
      showRollbackNotice(result.removedCount);
      requestAnimationFrame(() => {
        resizeInput();
        inputRef.current?.focus();
      });
    } catch (err) {
      console.error('Failed to rollback message:', err);
    }
  };

  const handleCopyMessage = async (message: AgentMessage) => {
    try {
      await writeText(message.content);
    } catch (err) {
      console.error('Failed to copy message:', err);
    }
  };

  const handleStop = () => {
    stopActiveTask();
  };

  const handleApprove = async () => {
    if (pendingApproval) {
      await approveCurrent(pendingApproval.toolCallId);
    }
  };

  const handleReject = async () => {
    if (pendingApproval) {
      await rejectCurrent(pendingApproval.toolCallId);
    }
  };

  const handleSubmitQuestion = async (questionId: string, answers: QuestionAnswer[]) => {
    await submitAnswer(questionId, answers);
  };

  const handleCancelQuestion = async () => {
    const answers: QuestionAnswer[] = (pendingQuestion?.questions ?? []).map(() => ({
      selected: [],
      custom: '',
    }));
    await submitAnswer(pendingQuestion!.questionId, answers);
  };

  const handleNewConversation = async () => {
    if (!canInteract || !activeConfigId) return;
    try {
      await newConversation(activeSessionId!, activeConfigId);
      setHistoryDrawerOpen(false);
    } catch (err) {
      console.error('Failed to create conversation:', err);
    }
  };

  const handleSelectConversation = async (conversationId: string) => {
    try {
      await switchConversation(conversationId);
      setHistoryDrawerOpen(false);
    } catch (err) {
      console.error('Failed to switch conversation:', err);
    }
  };

  const handleDeleteConversation = async (e: React.MouseEvent, conversationId: string) => {
    e.stopPropagation();
    try {
      await deleteConversation(conversationId);
    } catch (err) {
      console.error('Failed to delete conversation:', err);
    }
  };

  const currentModeInfo = AGENT_MODES.find((m) => m.value === mode) ?? AGENT_MODES[1];

  const isThinking = useMemo(
    () => messages.some((m) => m.role === 'assistant' && m.isThinking),
    [messages],
  );

  return (
    <div data-region="agent-panel" className="relative flex flex-col h-full bg-zinc-900">
      {/* Approval Dialog */}
      {pendingApproval && (
        <ApprovalDialog
          toolCall={{
            id: pendingApproval.toolCallId,
            name: pendingApproval.toolName,
            arguments: pendingApproval.arguments,
            riskLevel: pendingApproval.riskLevel,
            reasons: pendingApproval.reasons,
          }}
          onApprove={handleApprove}
          onReject={handleReject}
          open={!!pendingApproval}
          onClose={handleReject}
        />
      )}
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
        <h2 className="text-sm font-semibold text-zinc-200">智能助手</h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleNewConversation}
            disabled={!canInteract}
            className="p-1.5 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="新建会话"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => setHistoryDrawerOpen((v) => !v)}
            disabled={!canInteract}
            className="p-1.5 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="历史会话"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden p-3 space-y-1">
        {!activeSession && (
          <div className="text-center text-zinc-500 text-sm mt-8">
            <p>请先连接 SSH 服务器。</p>
            <p className="mt-1">
              连接成功后即可使用智能助手。
            </p>
          </div>
        )}
        {activeSession?.status === 'connecting' && (
          <div className="text-center text-zinc-500 text-sm mt-8">
            <p>正在连接 SSH 服务器...</p>
            <p className="mt-1">
              连接完成后将加载智能助手会话。
            </p>
          </div>
        )}
        {activeSession?.status === 'error' && (
          <div className="text-center text-zinc-500 text-sm mt-8">
            <p>连接失败。</p>
            {activeSession.errorMessage && (
              <p className="mt-1 text-zinc-600 break-words [overflow-wrap:anywhere]">
                {activeSession.errorMessage}
              </p>
            )}
          </div>
        )}
        {activeSession?.status === 'disconnected' && (
          <div className="text-center text-zinc-500 text-sm mt-8 space-y-3">
            <div>
              <p>SSH 连接已断开。</p>
              <p className="mt-1">
                请重新连接服务器后继续使用智能助手。
              </p>
            </div>
            {activeSession.configId ? (
              <Button
                variant="primary"
                onClick={() => {
                  reconnect(activeSession.id).catch((err) => {
                    console.error('重连失败:', err);
                  });
                }}
              >
                重新连接
              </Button>
            ) : (
              <p className="text-zinc-600">临时连接无法自动重连，请去侧边栏重新连接。</p>
            )}
          </div>
        )}
        {canInteract && messages.length === 0 && !activeConversationId && (
          <div className="text-center text-zinc-500 text-sm mt-8">
            <p>暂无会话。</p>
            <p className="mt-1">
              点击左上角 + 新建会话。
            </p>
          </div>
        )}
        {canInteract && messages.length === 0 && activeConversationId && (
          <div className="text-center text-zinc-500 text-sm mt-8">
            <p>暂无消息。</p>
            <p className="mt-1">
              描述您想要做的事情，智能助手将为您提供帮助。
            </p>
          </div>
        )}
        {canInteract && (
          <AgentMessageList
            messages={messages}
            isThinking={isThinking}
            isRunning={isRunning}
            onRollback={handleRollbackMessage}
            onCopy={handleCopyMessage}
            messagesEndRef={messagesEndRef}
          />
        )}
      </div>

      {/* PlanList - todolist rendered between messages and input */}
      <PlanList />

      {rollbackNotice && (
        <div className="border-t border-zinc-800 bg-zinc-900/90 backdrop-blur animate-fadeIn">
          <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-amber-200">
            <div className="flex items-center gap-2 min-w-0">
              <svg className="w-3.5 h-3.5 flex-shrink-0 text-amber-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
              </svg>
              <span className="truncate">{rollbackNotice}</span>
            </div>
            <button
              type="button"
              onClick={() => setRollbackNotice(null)}
              className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
              title="关闭"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Input area or Question panel */}
      {pendingQuestion ? (
        <QuestionPanel
          questionId={pendingQuestion.questionId}
          questions={pendingQuestion.questions}
          onSubmit={handleSubmitQuestion}
          onCancel={handleCancelQuestion}
        />
      ) : (
        <div className="p-3 border-t border-zinc-800">
          <div className="agent-input relative flex items-start rounded-lg bg-zinc-800 border border-zinc-700 focus-within:border-indigo-500">
          {/* Mode selector (inside input) */}
          <div className="relative flex-shrink-0 self-center" ref={drawerRef}>
            <button
              type="button"
              onClick={() => setModeDrawerOpen((v) => !v)}
              className={`
                flex items-center gap-1 px-2 py-2 text-xs font-medium transition-colors rounded-l-lg
                ${
                  modeDrawerOpen
                    ? 'bg-zinc-700 text-zinc-100'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50'
                }
              `}
              title={currentModeInfo.description}
              aria-haspopup="listbox"
              aria-expanded={modeDrawerOpen}
            >
              <span className="font-semibold tracking-wider">
                {currentModeInfo.label}
              </span>
              <svg
                className={`w-3 h-3 transition-transform ${
                  modeDrawerOpen ? 'rotate-180' : ''
                }`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 15l7-7 7 7"
                />
              </svg>
            </button>

            {modeDrawerOpen && (
              <div
                role="listbox"
                className="absolute bottom-full left-0 mb-2 w-64 rounded-xl border border-zinc-700 bg-zinc-800 shadow-2xl py-1 z-30"
              >
                {AGENT_MODES.map((m) => {
                  const active = m.value === mode;
                  return (
                    <button
                      key={m.value}
                      role="option"
                      aria-selected={active}
                      onClick={() => {
                        setMode(m.value as AgentMode);
                        setModeDrawerOpen(false);
                      }}
                      className={`
                        w-full text-left px-3 py-2 transition-colors
                        ${
                          active
                            ? 'bg-indigo-600/20 border-l-2 border-indigo-500'
                            : 'hover:bg-zinc-700 border-l-2 border-transparent'
                        }
                      `}
                    >
                      <div className="flex items-center justify-between">
                        <span
                          className={`text-sm font-bold tracking-wider ${
                            active ? 'text-indigo-300' : 'text-zinc-200'
                          }`}
                        >
                          {m.label}
                        </span>
                        {active && (
                          <span className="text-xs text-indigo-400">已选</span>
                        )}
                      </div>
                      <p className="text-xs text-zinc-400 mt-0.5">
                        {m.description}
                      </p>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="w-px h-5 bg-zinc-700 self-center" />

          {/* Input field */}
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={
              activeSession?.status === 'connecting'
                ? '正在连接服务器...'
                : canInteract
                ? '描述您想要做的事情...'
                : '请先连接到服务器...'
            }
            disabled={!canInteract}
            className="flex-1 min-w-0 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 bg-transparent outline-none focus:outline-none focus:ring-0 disabled:opacity-50 resize-none max-h-[6rem] overflow-y-auto leading-relaxed"
          />

          {/* Send / Stop button (inside input) */}
          <button
            type="button"
            onClick={isRunning ? handleStop : handleSend}
            disabled={!isRunning && (!input.trim() || !canInteract)}
            className={`
              flex-shrink-0 p-2 mr-1 self-center rounded-md transition-all
              ${isRunning
                ? 'bg-red-600 hover:bg-red-500 text-white'
                : 'bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50 disabled:cursor-not-allowed'
              }
            `}
            title={isRunning ? '停止' : '发送'}
          >
            {isRunning ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14m-7-7l7 7-7 7" />
              </svg>
            )}
          </button>
        </div>
      </div>
      )}

      {/* History Drawer */}
      {historyDrawerOpen && (
        <>
          <div
            className="absolute inset-0 bg-black/40 z-20 animate-fadeIn"
            onClick={() => setHistoryDrawerOpen(false)}
          />
          <div className="absolute top-0 right-0 h-full w-72 bg-zinc-950 border-l border-zinc-800 z-30 flex flex-col shadow-2xl animate-slideInRight">
            <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
              <h3 className="text-sm font-semibold text-zinc-200">历史会话</h3>
              <button
                type="button"
                onClick={() => setHistoryDrawerOpen(false)}
                className="p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {sessionConversations.length === 0 && (
                <div className="text-center text-zinc-500 text-sm mt-8">
                  <p>暂无历史会话</p>
                </div>
              )}
              {sessionConversations.map((conv) => {
                const isActive = conv.id === activeConversationId;
                return (
                  <div
                    key={conv.id}
                    className={`flex items-center gap-1 px-2 py-2 rounded-lg text-sm transition-colors ${
                      isActive
                        ? 'bg-zinc-800 text-zinc-100'
                        : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
                    }`}
                  >
                    <button
                      onClick={() => handleSelectConversation(conv.id)}
                      className="flex-1 text-left min-w-0"
                    >
                      <div className="truncate font-medium">
                        {conv.title}
                      </div>
                      <div className="text-xs text-zinc-500 mt-0.5">
                        {new Date(conv.updatedAt).toLocaleString()}
                      </div>
                    </button>
                    <button
                      onClick={(e) => handleDeleteConversation(e, conv.id)}
                      className="p-1 rounded text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors flex-shrink-0"
                      title="删除会话"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
