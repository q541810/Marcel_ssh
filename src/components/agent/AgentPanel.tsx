import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { useAgent } from '@/hooks/useAgent';
import { useSessionStore } from '@/stores/sessionStore';
import { useConnectionStore } from '@/stores/connectionStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { AGENT_MODES } from '@/lib/constants';
import type { AgentMode, AgentMessage, QuestionAnswer } from '@/lib/types';
import {
  type PendingImage,
  filesToPendingImages,
  revokePendingImages,
  compressImageFile,
  pendingImageFromDataUrl,
  deletePersistedImagePaths,
  MAX_ATTACH_IMAGES,
} from '@/lib/imageAttach';
import * as tauri from '@/lib/tauri';
import ChatHistoryModal from '@/components/settings/ChatHistoryModal';
import AgentMessageList from './AgentMessageList';
import ApprovalDialog from './ApprovalDialog';
import QuestionPanel from './QuestionPanel';
import PlanList from './PlanList';

export default function AgentPanel() {
  const [modeDrawerOpen, setModeDrawerOpen] = useState(false);
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [tokenPopoverOpen, setTokenPopoverOpen] = useState(false);
  const [rollbackNotice, setRollbackNotice] = useState<string | null>(null);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [attachHint, setAttachHint] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastScrolledMessageRef = useRef<string | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const rollbackNoticeTimerRef = useRef<number | null>(null);
  const attachHintTimerRef = useRef<number | null>(null);
  const sendingRef = useRef(false);
  const visionEnabled = useSettingsStore((s) => s.settings.llmConfig?.vision ?? false);
  const activeSession = useSessionStore((s) => {
    const session = s.activeSessionId ? s.sessions[s.activeSessionId] : null;
    return session ?? null;
  });
  const fetchConnections = useConnectionStore((s) => s.fetchConnections);
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
    taskTokenUsage,
    syncActiveToConnection,
  } = useAgent();

  const sessionConversations = useMemo(
    () => Object.values(conversations).filter((c) => c.connectionId === activeConfigId),
    [conversations, activeConfigId],
  );

  const canInteract = activeSession?.status === 'connected';

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  // SSH tab 切换时，把 Agent 聊天同步到对应 connection 的对话
  useEffect(() => {
    if (!activeConfigId) return;
    void syncActiveToConnection(activeConfigId);
  }, [activeConfigId, syncActiveToConnection]);

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
    if (attachHintTimerRef.current !== null) {
      window.clearTimeout(attachHintTimerRef.current);
    }
  }, []);

  const showAttachHint = useCallback((msg: string) => {
    setAttachHint(msg);
    if (attachHintTimerRef.current !== null) {
      window.clearTimeout(attachHintTimerRef.current);
    }
    attachHintTimerRef.current = window.setTimeout(() => {
      setAttachHint(null);
      attachHintTimerRef.current = null;
    }, 3200);
  }, []);

  const deletePersistedPaths = useCallback(async (paths: Array<string | undefined | null>) => {
    await deletePersistedImagePaths(paths, tauri.agentDeleteMessageImage);
  }, []);

  /** 清空预览；deleteDisk=true 时删除撤回恢复的落盘图 */
  const clearPendingImages = useCallback(
    (options?: { deleteDisk?: boolean }) => {
      const deleteDisk = options?.deleteDisk ?? false;
      setPendingImages((prev) => {
        if (deleteDisk) {
          void deletePersistedPaths(prev.map((p) => p.persistedPath));
        }
        revokePendingImages(prev);
        return [];
      });
    },
    [deletePersistedPaths],
  );

  const removePendingImage = useCallback(
    (id: string) => {
      setPendingImages((prev) => {
        const target = prev.find((p) => p.id === id);
        if (target?.persistedPath) {
          void deletePersistedPaths([target.persistedPath]);
        }
        if (target) revokePendingImages([target]);
        return prev.filter((p) => p.id !== id);
      });
    },
    [deletePersistedPaths],
  );

  // 切换对话/主机时丢掉草稿附件，避免把 A 的撤回图带到 B
  const prevConversationIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const prev = prevConversationIdRef.current;
    prevConversationIdRef.current = activeConversationId;
    if (prev === undefined) return; // 首次挂载
    if (prev === activeConversationId) return;
    clearPendingImages({ deleteDisk: true });
  }, [activeConversationId, clearPendingImages]);

  // Vision OFF：清空已挂起图片并删落盘图（未保留在预览）
  useEffect(() => {
    if (!visionEnabled && pendingImages.length > 0) {
      clearPendingImages({ deleteDisk: true });
      showAttachHint('当前模型未开启「视觉 / 支持图片」');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to vision toggle
  }, [visionEnabled]);

  const addPendingFromFiles = useCallback(
    async (files: FileList | File[]) => {
      if (!visionEnabled) {
        clearPendingImages({ deleteDisk: true });
        showAttachHint('当前模型未开启「视觉 / 支持图片」');
        return;
      }
      const { images, rejected } = await filesToPendingImages(files, pendingImages.length);
      if (rejected && images.length === 0) {
        showAttachHint(rejected);
        return;
      }
      if (rejected) showAttachHint(rejected);
      if (images.length > 0) {
        setPendingImages((prev) => [...prev, ...images].slice(0, MAX_ATTACH_IMAGES));
      }
    },
    [visionEnabled, pendingImages.length, clearPendingImages, showAttachHint],
  );

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length === 0) return;
    e.preventDefault();
    if (!visionEnabled) {
      clearPendingImages({ deleteDisk: true });
      showAttachHint('当前模型未开启「视觉 / 支持图片」');
      return;
    }
    if (pendingImages.length >= MAX_ATTACH_IMAGES) {
      showAttachHint(`最多 ${MAX_ATTACH_IMAGES} 张图片`);
      return;
    }
    const room = MAX_ATTACH_IMAGES - pendingImages.length;
    const added: PendingImage[] = [];
    for (const file of imageFiles.slice(0, room)) {
      try {
        const { dataUrl, previewUrl } = await compressImageFile(file);
        added.push({ id: crypto.randomUUID(), previewUrl, dataUrl });
      } catch {
        // skip
      }
    }
    if (added.length === 0) {
      showAttachHint('图片处理失败');
      return;
    }
    setPendingImages((prev) => [...prev, ...added].slice(0, MAX_ATTACH_IMAGES));
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (!canInteract) return;
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    await addPendingFromFiles(files);
  };

  const handleSend = async () => {
    if (isRunning || sendingRef.current) return;
    const prompt = input.trim();
    const images = visionEnabled ? pendingImages : [];
    if ((!prompt && images.length === 0) || !canInteract) return;
    if (!visionEnabled && pendingImages.length > 0) {
      clearPendingImages({ deleteDisk: true });
      showAttachHint('当前模型未开启「视觉 / 支持图片」');
      return;
    }
    sendingRef.current = true;
    const snapshotImages = images;
    const dataUrls = images.map((i) => i.dataUrl);
    const oldPersisted = images.map((i) => i.persistedPath).filter((p): p is string => !!p);
    setInput('');
    // 只清 UI 状态，blob URL 等成功后再 revoke；save 失败可原样回滚
    setPendingImages([]);
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }
    try {
      await sendPrompt(activeSessionId!, prompt, activeConfigId, dataUrls, oldPersisted);
      revokePendingImages(snapshotImages);
    } catch (err) {
      console.error('Failed to start task:', err);
      const stage = (err as Error & { stage?: string })?.stage;
      if (stage === 'start_task') {
        // 消息（含新图）已进会话；旧落盘图已在 save 后删除
        revokePendingImages(snapshotImages);
        return;
      }
      // save 失败或其它：恢复输入与预览，旧落盘图保留
      setInput(prompt);
      setPendingImages(snapshotImages);
      requestAnimationFrame(() => {
        resizeInput();
        inputRef.current?.focus();
      });
    } finally {
      sendingRef.current = false;
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

      // 先清当前预览（若有撤回恢复的落盘图也删掉）
      clearPendingImages({ deleteDisk: true });
      const paths = result.imagePaths?.length
        ? result.imagePaths
        : (message.imagePaths ?? []);
      if (paths.length > 0 && visionEnabled) {
        const restored: PendingImage[] = [];
        const failedPaths: string[] = [];
        for (const path of paths.slice(0, MAX_ATTACH_IMAGES)) {
          try {
            const dataUrl = await tauri.agentReadMessageImage(path);
            restored.push(pendingImageFromDataUrl(dataUrl, path));
          } catch (err) {
            console.warn('Failed to restore image after rollback:', path, err);
            failedPaths.push(path);
          }
        }
        // 超出上限的路径也视为未进预览，删掉
        if (paths.length > MAX_ATTACH_IMAGES) {
          failedPaths.push(...paths.slice(MAX_ATTACH_IMAGES));
        }
        if (failedPaths.length > 0) {
          void deletePersistedPaths(failedPaths);
        }
        if (restored.length > 0) {
          setPendingImages(restored);
        } else if (paths.length > 0) {
          showAttachHint('原消息图片恢复失败');
        }
      } else if (paths.length > 0 && !visionEnabled) {
        // 未回到预览：清磁盘
        void deletePersistedPaths(paths);
        showAttachHint('当前模型未开启「视觉 / 支持图片」，图片未恢复');
      }

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
            metadata: pendingApproval.metadata,
          }}
          onApprove={handleApprove}
          onReject={handleReject}
          open={!!pendingApproval}
          onClose={handleReject}
        />
      )}
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
        <div className="flex items-center gap-1.5">
          <h2 className="text-sm font-semibold text-zinc-200">智能助手</h2>
          <div className="relative">
            <button
              type="button"
              onClick={() => setTokenPopoverOpen((v) => !v)}
              className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-medium transition-colors ${
                tokenPopoverOpen
                  ? 'bg-indigo-600 text-white'
                  : 'bg-zinc-700 text-zinc-400 hover:bg-zinc-600 hover:text-zinc-200'
              }`}
              title="Token 用量"
            >
              T
            </button>
            {tokenPopoverOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setTokenPopoverOpen(false)}
                />
                <div className="absolute top-full left-0 mt-2 w-56 bg-zinc-800 border border-zinc-700 rounded-xl shadow-2xl z-50 py-2 animate-fadeIn">
                  <div className="px-3 py-1 text-xs font-semibold text-zinc-300 border-b border-zinc-700 pb-1.5 mb-1">
                    Token 用量
                  </div>
                  <div className="px-3 py-0.5 text-xs text-zinc-400 space-y-0.5">
                    <div className="flex justify-between">
                      <span>本次输入</span>
                      <span className="text-zinc-200 tabular-nums">
                        {taskTokenUsage ? taskTokenUsage.promptTokens.toLocaleString() : '—'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>本次输出</span>
                      <span className="text-zinc-200 tabular-nums">
                        {taskTokenUsage ? taskTokenUsage.completionTokens.toLocaleString() : '—'}
                      </span>
                    </div>
                    {taskTokenUsage?.reasoningTokens != null && (
                      <div className="flex justify-between">
                        <span>本次推理</span>
                        <span className="text-zinc-200 tabular-nums">
                          {taskTokenUsage.reasoningTokens.toLocaleString()}
                        </span>
                      </div>
                    )}
                    {taskTokenUsage?.cachedReadTokens != null && (
                      <>
                        <div className="flex justify-between">
                          <span>缓存读取</span>
                          <span className="text-zinc-200 tabular-nums">
                            {taskTokenUsage.cachedReadTokens.toLocaleString()}
                          </span>
                        </div>
                        {taskTokenUsage.promptTokens > 0 && (() => {
                          const rate = taskTokenUsage.cachedReadTokens / taskTokenUsage.promptTokens * 100;
                          return (
                            <div className="flex flex-col gap-0.5">
                              <div className="flex justify-between">
                                <span>缓存命中率</span>
                                <span className="text-zinc-200 tabular-nums">
                                  {Math.round(rate)}%
                                </span>
                              </div>
                              {rate > 0 && (
                                <div className="w-full h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                                  <div
                                    className="h-full bg-indigo-500 rounded-full transition-all"
                                    style={{ width: `${Math.min(rate, 100)}%` }}
                                  />
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </>
                    )}
                  </div>
                  <div className="px-3 pt-1.5 mt-1 border-t border-zinc-700">
                    <p className="text-[10px] text-zinc-600">数据来源：LLM供应商返回的Usage</p>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
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
            onClick={() => {
              if (canInteract) {
                setHistoryDrawerOpen((v) => !v);
              } else {
                setShowHistoryModal(true);
              }
            }}
            className="p-1.5 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 transition-colors"
            title="历史会话"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden p-3 space-y-1">
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
            <p>连接失败，请在标签栏重新连接。</p>
          </div>
        )}
        {activeSession?.status === 'disconnected' && (
          <div className="text-center text-zinc-500 text-sm mt-8">
            <p>连接已断开，请在标签栏重新连接。</p>
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
        <div
          className="p-3 border-t border-zinc-800"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {attachHint && (
            <div className="mb-2 px-2 py-1.5 rounded-md bg-amber-950/60 border border-amber-800/50 text-xs text-amber-200">
              {attachHint}
            </div>
          )}
          {pendingImages.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {pendingImages.map((img) => (
                <div key={img.id} className="relative h-14 w-14">
                  <img
                    src={img.previewUrl}
                    alt=""
                    className="h-full w-full object-cover rounded-md border border-zinc-600"
                  />
                  <button
                    type="button"
                    onClick={() => removePendingImage(img.id)}
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-zinc-900 border border-zinc-600 text-zinc-300 hover:text-white hover:bg-red-600 flex items-center justify-center text-[10px] leading-none"
                    title="移除"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <div
            className={`agent-input relative flex items-start rounded-lg bg-zinc-800 border focus-within:border-indigo-500 ${
              dragOver ? 'border-indigo-400 ring-1 ring-indigo-500/40' : 'border-zinc-700'
            }`}
          >
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
            onPaste={handlePaste}
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
            disabled={
              !isRunning &&
              ((!input.trim() && pendingImages.length === 0) || !canInteract)
            }
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

      <ChatHistoryModal open={showHistoryModal} onClose={() => setShowHistoryModal(false)} />
    </div>
  );
}
