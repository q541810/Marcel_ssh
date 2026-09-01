import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowUp, ChevronDown, Plus, Square } from "lucide-react";
import { Pencil, Trash2 } from "lucide-react";
import { useAgent } from "@/hooks/useAgent";
import { useTaskStore } from "@/stores/taskStore";
import { getConversationAgentStatus, getActiveRunningTasks } from "@/stores/agentStatusSelectors";
import { AgentStatusIndicator } from "@/components/agent/AgentStatusIndicator";
import MobileActiveAgentsSheet from "./MobileActiveAgentsSheet";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSessionStore } from "@/stores/sessionStore";
import {
  useConversationStore,
  conversationHasRunningTask,
} from "@/stores/conversationStore";
import { sessionConversationBindingManager } from "@/stores/sessionConversationBindingManager";
import { groupConversationsByDate } from "@/lib/dateGrouping";
import { AGENT_MODES } from "@/lib/constants";
import { currentVision } from "@/lib/llmRegistry";
import { useSettingsStore } from "@/stores/settingsStore";
import type { AgentMessage, AgentMode, QuestionAnswer } from "@/lib/types";
import AgentMessageList from "@/components/agent/AgentMessageList";
import PlanList from "@/components/agent/PlanList";
import AgentCommandMenu from "@/components/agent/AgentCommandMenu";
import { ModelPicker } from "@/components/agent/ModelPicker";
import { registerBackHandler } from "./backHandler";
import MobileApprovalSheet from "./MobileApprovalSheet";
import MobileQuestionSheet from "./MobileQuestionSheet";
import MobileChatHistorySheet from "./MobileChatHistorySheet";
import MobileSheet from "./ui/MobileSheet";
import {
  agentEmptyStateReason,
  canSendAgentPrompt,
  resolveAgentIds,
  type AgentEmptyStateReason,
} from "./agentUi";
import {
  isNearBottom,
  shouldAutoScroll,
  shouldShowScrollToBottomFab,
} from "./agentScroll";
import { resolveSessionDisplayName, sessionStatusLabel } from "./sessionUi";
import {
  type PendingImage,
  revokePendingImages,
  compressImageFile,
  MAX_ATTACH_IMAGES,
} from "@/lib/imageAttach";
import {
  classifyAttachment,
  blobToText,
  wrapTextAttachment,
  base64ToBlob,
  readLocalAttachment,
  MAX_TEXT_FILE_BYTES,
} from "@/lib/attachmentAttach";

const NEAR_BOTTOM_THRESHOLD_PX = 80;

interface MobileAgentHostProps {
  /** When false, host stays mounted but hidden (tab keep-alive). */
  visible?: boolean;
}

const EMPTY_STATE_COPY: Record<
  Exclude<AgentEmptyStateReason, "ready">,
  { title: string; body: string }
> = {
  "no-session": {
    title: "未选择会话",
    body: "请先在终端页连接 SSH 服务器。",
  },
  connecting: {
    title: "正在连接…",
    body: "连接完成后可使用智能助手。",
  },
  disconnected: {
    title: "连接已断开",
    body: "请在终端页重新连接后再使用。",
  },
  error: {
    title: "连接失败",
    body: "请在终端页检查连接后重试。",
  },
  "no-config": {
    title: "无法使用助手",
    body: "当前会话未绑定已保存连接，请从连接列表重新连接。",
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
  const canInteract = !!ids && activeSession?.status === "connected";
  const emptyReason = agentEmptyStateReason(activeSession);
  const visionEnabled = useSettingsStore(
    (s) => currentVision(s.settings.llmRegistry),
  );

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
    loadConversation,
    renameConversation,
    deleteConversation,
    setConversationModel,
    syncActiveToConnection,
    rollbackToMessage,
  } = useAgent();

  const [modeOpen, setModeOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const modePresence = useAnimatedPresence(modeOpen);
  const historyPresence = useAnimatedPresence(historyOpen);
  /** 未连接时的只读历史浏览面板（对齐桌面 AgentPanel 的 ChatHistoryModal 分支） */
  const [historyBrowserOpen, setHistoryBrowserOpen] = useState(false);
  const [activeAgentsSheetOpen, setActiveAgentsSheetOpen] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [rollbackHint, setRollbackHint] = useState<string | null>(null);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [attachHint, setAttachHint] = useState<string | null>(null);
  const [nearBottom, setNearBottom] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sendingRef = useRef(false);
  const lastScrolledMessageRef = useRef<string | null>(null);
  const rollbackHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const attachHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const nearBottomRef = useRef(true);
  const userJustSentRef = useRef(false);
  const prevVisibleRef = useRef(visible);
  const messageCountAtHideRef = useRef(0);

  const [renameTargetId, setRenameTargetId] = useState<string | null>(null);
  const [renameTitleInput, setRenameTitleInput] = useState("");

  const tasks = useTaskStore((s) => s.tasks);
  const unreadCompletedConversations = useTaskStore(
    (s) => s.unreadCompletedConversations,
  );
  const runningTasks = useMemo(() => getActiveRunningTasks(tasks), [tasks]);

  const sessionConversations = useMemo(
    () =>
      Object.values(conversations).filter(
        (c) =>
          ids?.configId != null &&
          c.connectionId === ids.configId &&
          // 子agent对话不在会话列表展示：只通过主对话的 task 卡片进入/返回
          !c.parentConversationId,
      ),
    [conversations, ids?.configId],
  );

  const groupedSessionConversations = useMemo(
    () => groupConversationsByDate(sessionConversations),
    [sessionConversations],
  );

  const handleStartRename = (convId: string, currentTitle: string) => {
    setRenameTargetId(convId);
    setRenameTitleInput(currentTitle);
  };

  const handleConfirmRename = async () => {
    if (!renameTargetId) return;
    const trimmed = renameTitleInput.trim();
    if (trimmed) {
      try {
        await renameConversation(renameTargetId, trimmed);
      } catch (err) {
        console.error("Failed to rename conversation:", err);
      }
    }
    setRenameTargetId(null);
    setRenameTitleInput("");
  };

  const currentModeInfo =
    AGENT_MODES.find((m) => m.value === mode) ?? AGENT_MODES[1];
  const isThinking = useMemo(
    () => messages.some((m) => m.role === "assistant" && m.isThinking),
    [messages],
  );

  useEffect(() => {
    if (!ids?.configId || !ids?.sessionId) return;
    void syncActiveToConnection(ids.configId, ids.sessionId);
  }, [ids?.configId, ids?.sessionId, syncActiveToConnection]);

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

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollContainerRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior });
    } else {
      messagesEndRef.current?.scrollIntoView({ behavior, block: "end" });
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
    scrollToBottom(isNew ? "smooth" : "auto");
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
      scrollToBottom("auto");
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
        scrollToBottom("auto");
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollToBottom]);

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
        custom: "",
      }),
    );
    await submitAnswer(pendingQuestion.questionId, answers);
  }, [pendingQuestion, submitAnswer]);

  // 子agent对话：输入区替换为"返回主对话"条（子agent由主 Agent 停止，停止主 Agent 级联停止）
  const activeConversation = activeConversationId
    ? (conversations[activeConversationId] ?? null)
    : null;
  const isSubConversation = !!activeConversation?.parentConversationId;
  const parentConversationId = activeConversation?.parentConversationId ?? null;

  const handleBackToParent = useCallback(() => {
    if (parentConversationId) {
      void switchConversation(parentConversationId);
    }
  }, [parentConversationId, switchConversation]);

  const handleNewConversation = useCallback(async () => {
    if (!canInteract || !ids) return;
    try {
      await newConversation(ids.sessionId, ids.configId);
      setHistoryOpen(false);
    } catch (err) {
      console.error("Failed to create conversation:", err);
    }
  }, [canInteract, ids, newConversation]);

  const handleSelectConversation = useCallback(
    async (conversationId: string) => {
      try {
        await sessionConversationBindingManager.selectOrJumpToConversation(
          conversationId,
          ids?.sessionId ?? null,
        );
        setHistoryOpen(false);
      } catch (err) {
        console.error("Failed to switch conversation:", err);
      }
    },
    [ids?.sessionId],
  );

  const handleDeleteConversation = useCallback(async () => {
    if (!deleteTargetId) return;
    const id = deleteTargetId;
    setDeleteTargetId(null);
    try {
      await deleteConversation(id);
    } catch (err) {
      console.error("Failed to delete conversation:", err);
    }
  }, [deleteTargetId, deleteConversation]);

  const deleteTargetTitle = deleteTargetId
    ? (conversations[deleteTargetId]?.title ?? "该会话")
    : "";

  const showRollbackHint = useCallback((text: string) => {
    setRollbackHint(text);
    if (rollbackHintTimerRef.current)
      clearTimeout(rollbackHintTimerRef.current);
    rollbackHintTimerRef.current = setTimeout(
      () => setRollbackHint(null),
      3200,
    );
  }, []);

  const showAttachHint = useCallback((text: string) => {
    setAttachHint(text);
    if (attachHintTimerRef.current) clearTimeout(attachHintTimerRef.current);
    attachHintTimerRef.current = setTimeout(() => setAttachHint(null), 3200);
  }, []);

  /** 清空图片预览（不删盘：撤回恢复图不适用于移动端无图场景，仅 blob 回收）。 */
  const clearPendingImages = useCallback(() => {
    setPendingImages((prev) => {
      revokePendingImages(prev);
      return [];
    });
  }, []);

  const removePendingImage = useCallback(
    (id: string) => {
      setPendingImages((prev) => {
        const target = prev.find((p) => p.id === id);
        if (target) revokePendingImages([target]);
        return prev.filter((p) => p.id !== id);
      });
    },
    [],
  );

  /** 切换对话 / 会话时清空附件预览，避免把 A 会话的图片带到 B。 */
  useEffect(() => {
    clearPendingImages();
  }, [activeConversationId, clearPendingImages]);

  /** 卸载时清理计时器 + blob URL。 */
  useEffect(() => {
    return () => {
      if (rollbackHintTimerRef.current)
        clearTimeout(rollbackHintTimerRef.current);
      if (attachHintTimerRef.current)
        clearTimeout(attachHintTimerRef.current);
      setPendingImages((prev) => {
        revokePendingImages(prev);
        return [];
      });
    };
  }, []);

  /** Vision OFF：清空已挂起图片。 */
  useEffect(() => {
    if (!visionEnabled && pendingImages.length > 0) {
      clearPendingImages();
      showAttachHint("当前模型未开启「视觉 / 支持图片」");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to vision toggle
  }, [visionEnabled]);

  /** 追加文本附件到输入框草稿（带文件名标记）。 */
  const appendTextAttachment = useCallback(
    (text: string) => {
      setInputDraft((prev) => (prev ? prev + text : text));
      requestAnimationFrame(() => {
        if (inputRef.current) {
          inputRef.current.style.height = "auto";
          inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 120)}px`;
        }
      });
    },
    [setInputDraft],
  );

  /** 统一处理一组本地路径（文件选择器返回）：图片 → 预览区，文本 → 插入输入框。 */
  const handleAttachmentPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;

      const imagePaths: string[] = [];
      const textPaths: string[] = [];
      const unsupported: string[] = [];
      for (const p of paths) {
        const name = p.split(/[/\\]/).pop() || p;
        const kind = classifyAttachment(name);
        if (kind === "image") imagePaths.push(p);
        else if (kind === "text") textPaths.push(p);
        else unsupported.push(name);
      }

      // 明确提示不支持的文件，避免静默吞掉（如 .zip/.exe/.pdf）
      if (unsupported.length > 0) {
        const shown = unsupported.slice(0, 3).join("、");
        const more = unsupported.length > 3 ? ` 等 ${unsupported.length} 个` : "";
        showAttachHint(`不支持的文件类型已跳过：${shown}${more}`);
      }

      // 图片 → 预览（读本地 → 压缩，与桌面 ctrl+v 同链路）
      if (imagePaths.length > 0) {
        if (!visionEnabled) {
          clearPendingImages();
          showAttachHint("当前模型未开启「视觉 / 支持图片」");
        } else {
          const room = MAX_ATTACH_IMAGES - pendingImages.length;
          const added: PendingImage[] = [];
          for (const p of imagePaths.slice(0, room)) {
            try {
              const { base64 } = await readLocalAttachment(p);
              const blob = base64ToBlob(base64, "image/*");
              const { dataUrl, previewUrl } = await compressImageFile(blob);
              added.push({ id: crypto.randomUUID(), previewUrl, dataUrl });
            } catch {
              // skip broken files
            }
          }
          if (added.length > 0) {
            setPendingImages((prev) =>
              [...prev, ...added].slice(0, MAX_ATTACH_IMAGES),
            );
          }
          if (imagePaths.length > room) {
            showAttachHint(`最多 ${MAX_ATTACH_IMAGES} 张，已忽略多余图片`);
          }
        }
      }

      // 文本 → 输入框
      for (const p of textPaths) {
        try {
          const { name, base64, size } = await readLocalAttachment(p);
          if (size > MAX_TEXT_FILE_BYTES) {
            showAttachHint(
              `「${name}」超过 ${Math.round(MAX_TEXT_FILE_BYTES / 1024 / 1024)}MB，已跳过`,
            );
            continue;
          }
          const content = await blobToText(base64ToBlob(base64));
          appendTextAttachment(wrapTextAttachment(name, content));
        } catch {
          const name = p.split(/[/\\]/).pop() || p;
          showAttachHint(`读取「${name}」失败`);
        }
      }
    },
    [
      visionEnabled,
      pendingImages.length,
      clearPendingImages,
      showAttachHint,
      appendTextAttachment,
    ],
  );

  /** 附件按钮：系统文件选择器（图片 / 文本 / 所有文件）。Android 取消会 reject。 */
  const handleAttach = useCallback(async () => {
    if (!canInteract || !ids) return;
    try {
      const selected = await open({
        multiple: true,
        title: "添加图片和文件",
        filters: [
          {
            name: "图片",
            extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"],
          },
          {
            name: "文本",
            extensions: [
              "md", "txt", "log", "json", "yml", "yaml", "xml", "csv",
              "ini", "conf", "sh", "py", "js", "ts", "html", "css",
              "sql", "toml", "svg",
            ],
          },
          { name: "所有文件", extensions: ["*"] },
        ],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      await handleAttachmentPaths(paths);
    } catch (err) {
      // Android 上取消文件选择器是 reject 而非返回 null，不当作错误
      const message = err instanceof Error ? err.message : "";
      if (/cancel|cancelled|dismiss/i.test(message)) return;
      showAttachHint("打开文件选择器失败");
    }
  }, [canInteract, ids, handleAttachmentPaths, showAttachHint]);

  const handleSend = useCallback(async () => {
    if (isRunning || sendingRef.current) return;
    if (!canSendAgentPrompt(activeSession, isRunning, inputDraft)) return;
    if (!ids) return;
    const prompt = inputDraft.trim();
    const images = visionEnabled ? pendingImages : [];
    if ((!prompt && images.length === 0) || !canInteract) return;
    if (!visionEnabled && pendingImages.length > 0) {
      clearPendingImages();
      showAttachHint("当前模型未开启「视觉 / 支持图片」");
      return;
    }
    const snapshotImages = images;
    const dataUrls = images.map((i) => i.dataUrl);
    sendingRef.current = true;
    userJustSentRef.current = true;
    setInputDraft("");
    setPendingImages([]);
    if (inputRef.current) inputRef.current.style.height = "auto";
    try {
      await sendPrompt(ids.sessionId, prompt, ids.configId, dataUrls);
      revokePendingImages(snapshotImages);
    } catch (err) {
      console.error("Failed to start task:", err);
      // 失败恢复：输入与预览原样回滚（对齐桌面 handleSend 语义）
      setInputDraft(prompt);
      setPendingImages(snapshotImages);
      userJustSentRef.current = false;
    } finally {
      sendingRef.current = false;
    }
  }, [
    activeSession,
    ids,
    inputDraft,
    isRunning,
    canInteract,
    sendPrompt,
    setInputDraft,
    visionEnabled,
    pendingImages,
    clearPendingImages,
    showAttachHint,
  ]);

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
            inputRef.current.style.height = "auto";
            inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 120)}px`;
            inputRef.current.focus();
          }
        });
      } catch (err) {
        console.error("Failed to rollback message:", err);
        showRollbackHint("撤回失败");
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
      console.error("Failed to copy message:", err);
    }
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputDraft(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  // ── `/` 命令面板（与桌面同款组件）：输入以 "/" 开头时在输入框上方弹出，
  // 手机端以触摸点选为主；软键盘回车/发送语义不变（handleKeyDown 不拦截）。
  // 任务运行中不唤出（与桌面一致）：手动压缩与运行中任务并发会造成替换竞态。
  const commandMenuOpen =
    inputDraft.startsWith("/") &&
    !/\s/.test(inputDraft) &&
    (!activeConversationId ||
      !conversationHasRunningTask(activeConversationId));
  const commandMenuQuery = commandMenuOpen ? inputDraft.slice(1) : "";

  const handleCompact = useCallback(() => {
    if (!activeConversationId) return;
    // 压缩结果/失败以消息卡片形式出现在会话列表里（compactConversation 内部处理）
    useConversationStore
      .getState()
      .compactConversation(activeConversationId)
      .catch((err) => {
        console.error("Failed to compact conversation:", err);
      });
  }, [activeConversationId]);

  const handleInsertSkill = useCallback(
    (prompt: string) => {
      setInputDraft(prompt);
      requestAnimationFrame(() => {
        if (inputRef.current) {
          inputRef.current.style.height = "auto";
          inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 120)}px`;
          inputRef.current.focus();
        }
      });
    },
    [setInputDraft],
  );

  // 菜单打开时系统返回键 = 关闭（清空命令输入）
  useEffect(() => {
    if (!commandMenuOpen) return;
    return registerBackHandler(() => setInputDraft(""));
  }, [commandMenuOpen, setInputDraft]);

  const sendEnabled =
    !!ids &&
    canSendAgentPrompt(activeSession, isRunning, inputDraft, pendingImages.length > 0);
  const hostLabel =
    resolveSessionDisplayName(activeSession, connections) || "智能助手";
  const statusText = activeSession
    ? sessionStatusLabel(activeSession.status)
    : "无会话";

  return (
    <div
      className="relative flex h-full min-h-0 flex-col bg-zinc-950"
      data-region="mobile-agent"
    >
      <header
        className="flex flex-shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-950 px-3 py-2"
        style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top, 0px))" }}
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-zinc-100">
            {hostLabel}
          </div>
          <div
            className={`text-[11px] ${
              activeSession?.status === "connected"
                ? "text-emerald-400"
                : activeSession?.status === "connecting"
                  ? "text-amber-400"
                  : activeSession?.status === "error"
                    ? "text-red-400"
                    : "text-zinc-500"
            }`}
          >
            {statusText}
            {isRunning ? " · 运行中" : ""}
          </div>
        </div>
        {(runningTasks.length > 1 ||
          (runningTasks.length === 1 &&
            runningTasks[0].conversationId !== activeConversationId)) && (
          <button
            type="button"
            onClick={() => setActiveAgentsSheetOpen(true)}
            className="flex items-center gap-1 px-2 py-1 bg-indigo-500/10 active:scale-95 border border-indigo-500/30 rounded-full text-indigo-300 text-xs font-medium transition-all"
            title="查看所有运行中的任务"
          >
            <AgentStatusIndicator status="running" size="xs" />
            <span>{runningTasks.length} 个运行中</span>
          </button>
        )}
        <button
          type="button"
          onClick={() => void handleNewConversation()}
          disabled={!canInteract || !ids}
          className="rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white transition-transform duration-100 active:scale-95 active:bg-indigo-500 disabled:opacity-40"
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
          {emptyReason !== "ready" && (
            <div className="mt-10 text-center text-sm text-zinc-500">
              <p className="font-medium text-zinc-400">
                {EMPTY_STATE_COPY[emptyReason].title}
              </p>
              <p className="mt-1">{EMPTY_STATE_COPY[emptyReason].body}</p>
            </div>
          )}
          {emptyReason === "ready" && messages.length === 0 && (
            <div className="mt-10 text-center text-sm text-zinc-500">
              <p className="font-medium text-zinc-400">
                {activeConversationId ? "暂无消息" : "暂无会话"}
              </p>
              <p className="mt-1">
                {activeConversationId
                  ? "描述您想做的事，智能助手会协助您。"
                  : "点击「新对话」开始，或直接输入发送。"}
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
            onClick={() => scrollToBottom("smooth")}
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
              historyPresence.phase === "exit"
                ? "mobile-backdrop-exit"
                : "mobile-backdrop-enter"
            }`}
            onClick={() => setHistoryOpen(false)}
          />
          <div
            onAnimationEnd={historyPresence.onAnimationEnd}
            className={`absolute inset-x-0 bottom-0 z-30 max-h-[55%] overflow-y-auto rounded-t-2xl border-t border-zinc-700 bg-zinc-900 p-3 shadow-2xl ${
              historyPresence.phase === "exit"
                ? "mobile-sheet-exit"
                : "mobile-sheet-enter"
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
              <div className="space-y-3">
                {groupedSessionConversations.map((group) => (
                  <div key={group.key} className="space-y-1">
                    <div className="px-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                      {group.label}
                    </div>
                    <ul className="space-y-1">
                      {group.items.map((conv) => {
                        const active = conv.id === activeConversationId;
                        return (
                          <li
                            key={conv.id}
                            className={`flex items-center gap-1 rounded-lg ${
                              active
                                ? "bg-indigo-600/20 text-indigo-200"
                                : "bg-zinc-800/60 text-zinc-300"
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => void handleSelectConversation(conv.id)}
                              className="min-w-0 flex-1 px-3 py-2 text-left text-sm active:opacity-80 flex items-center justify-between gap-2"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="truncate font-medium leading-snug">{conv.title}</div>
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
                              onClick={() => handleStartRename(conv.id, conv.title)}
                              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-zinc-400 active:bg-zinc-800 active:text-zinc-200"
                              aria-label={`重命名 ${conv.title}`}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeleteTargetId(conv.id)}
                              className="mr-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-zinc-400 active:bg-zinc-800 active:text-red-400"
                              aria-label={`删除 ${conv.title}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      <MobileSheet
        open={renameTargetId != null}
        onClose={() => setRenameTargetId(null)}
        title="重命名会话"
      >
        <div className="flex flex-col gap-3 px-4 pb-4">
          <input
            type="text"
            value={renameTitleInput}
            onChange={(e) => setRenameTitleInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
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
              onClick={() => setRenameTargetId(null)}
              className="flex-1 rounded-xl bg-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-300 active:bg-zinc-700"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void handleConfirmRename()}
              disabled={!renameTitleInput.trim()}
              className="flex-1 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50 active:bg-indigo-500"
            >
              保存
            </button>
          </div>
        </div>
      </MobileSheet>

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

      <MobileActiveAgentsSheet
        open={activeAgentsSheetOpen}
        onClose={() => setActiveAgentsSheetOpen(false)}
      />

      {isSubConversation ? (
        <div className="flex-shrink-0 border-t border-zinc-800 p-3">
          <div className="flex items-center gap-3 rounded-xl border border-zinc-700/60 bg-zinc-900/70 px-3 py-3">
            <button
              type="button"
              onClick={handleBackToParent}
              className="flex flex-shrink-0 items-center gap-1 rounded-lg bg-indigo-600/20 px-2.5 py-2 text-xs font-medium text-indigo-300 transition-transform duration-100 active:scale-95 active:bg-indigo-600/30"
            >
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10 19l-7-7m0 0l7-7m-7 7h18"
                />
              </svg>
              返回主对话
            </button>
            <div className="min-w-0 flex-1 border-l border-zinc-700/50 pl-3">
              <div className="truncate text-xs text-zinc-400">
                子agent调研 · {activeConversation?.title ?? "子agent对话"}
              </div>
              <div className="mt-0.5 text-[11px] text-zinc-600">
                由主 Agent 派发的只读调研，不支持输入
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="relative flex-shrink-0 border-t border-zinc-800 p-3">
          {/* `/` 命令面板：锚定输入框上方，触摸点选执行；遮罩点击/返回键关闭 */}
          {commandMenuOpen && (
            <div
              className="fixed inset-0 z-40"
              onClick={() => setInputDraft("")}
              aria-hidden
            />
          )}
          <AgentCommandMenu
            open={commandMenuOpen}
            query={commandMenuQuery}
            currentMode={mode}
            onSelectMode={setMode}
            onInsertSkill={handleInsertSkill}
            onCompact={handleCompact}
            onClose={() => setInputDraft("")}
          />
          {attachHint && (
            <div className="mb-2 rounded-lg border border-amber-800/50 bg-amber-950/60 px-2.5 py-1.5 text-xs text-amber-200">
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
                    className="h-full w-full rounded-lg border border-zinc-600 object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removePendingImage(img.id)}
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-zinc-600 bg-zinc-900 text-[11px] leading-none text-zinc-300 active:bg-red-600 active:text-white"
                    title="移除"
                    aria-label="移除图片"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="agent-input rounded-2xl border border-zinc-700 bg-zinc-900 focus-within:border-indigo-500">
            <textarea
              ref={inputRef}
              rows={1}
              value={inputDraft}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder={
                !canInteract
                  ? "请先连接服务器…"
                  : !ids
                    ? "请从连接列表重新连接…"
                    : "描述您想要做的事情，输入 / 可查看命令…"
              }
              disabled={!canInteract || !ids}
              className="w-full min-h-[2.5rem] max-h-[7.5rem] resize-none bg-transparent px-3.5 pt-3 pb-1 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none focus:outline-none focus-visible:outline-none disabled:opacity-50"
            />
            <div className="flex items-center px-1.5 pb-1.5">
              {/* 附件按钮：图片/文本文件导入 */}
              <button
                type="button"
                onClick={() => void handleAttach()}
                disabled={!canInteract || !ids}
                className="flex-shrink-0 p-1.5 -ml-0.5 text-zinc-400 active:text-zinc-200 active:bg-zinc-800 rounded-full transition-transform duration-150 active:scale-90 disabled:opacity-40"
                title="添加图片或文本文件"
                aria-label="添加图片或文本文件"
              >
                <Plus className="h-[18px] w-[18px]" />
              </button>
              <div className="relative flex-shrink-0">
                <button
                  type="button"
                  onClick={() => setModeOpen((v) => !v)}
                  className="flex items-center gap-1 rounded-full px-2 py-1.5 text-xs font-medium text-zinc-300 active:bg-zinc-800 transition-transform duration-150 active:scale-95"
                  title={currentModeInfo.description}
                >
                  {currentModeInfo.label}
                  <ChevronDown className="h-3 w-3" />
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
                    modePresence.phase === "exit"
                      ? "mobile-popover-exit"
                      : "mobile-popover-enter"
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
                            ? "bg-indigo-600/20 text-indigo-200"
                            : "text-zinc-200 active:bg-zinc-700"
                        }`}
                      >
                        <div className="font-semibold">
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
            {/* 会话级模型切换（compact 图标态） */}
            <ModelPicker
              value={activeConversation?.modelId}
              onChange={(modelId) => {
                if (!activeConversationId) return;
                void setConversationModel(activeConversationId, modelId);
              }}
              disabled={!canInteract || !ids}
              compact
            />
            <div className="flex-1 min-w-2" />
            <button
              type="button"
              onClick={() => (isRunning ? handleStop() : void handleSend())}
              disabled={!isRunning && !sendEnabled}
              className={`mr-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-white transition-transform duration-150 active:scale-95 disabled:opacity-40 ${
                isRunning
                  ? "bg-red-600 active:bg-red-500"
                  : "bg-indigo-600 active:bg-indigo-500"
              }`}
              title={isRunning ? "停止" : "发送"}
              aria-label={isRunning ? "停止" : "发送"}
            >
              {isRunning ? (
                <Square className="h-4 w-4 fill-current" />
              ) : (
                <ArrowUp className="h-[18px] w-[18px]" />
              )}
            </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
