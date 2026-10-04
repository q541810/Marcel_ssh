import {
  useState,
  useRef,
  useEffect,
  useMemo,
  useCallback,
} from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import * as tauri from "@/lib/tauri";
import { useAgent } from "@/hooks/useAgent";
import { useTaskStore } from "@/stores/taskStore";
import { AgentTasksDrawer } from "./AgentTasksDrawer";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import { useSessionStore } from "@/stores/sessionStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import {
  useConversationStore,
  conversationIsBusy,
} from "@/stores/conversationStore";
import { sessionConversationBindingManager } from "@/stores/sessionConversationBindingManager";
import { isLocalSessionId } from "@/lib/toolCatalog";
import { currentVision } from "@/lib/llmRegistry";
import type { AgentMessage } from "@/lib/types";
import {
  type PendingImage,
  revokePendingImages,
  pendingImageFromDataUrl,
  MAX_ATTACH_IMAGES,
} from "@/lib/imageAttach";
import ChatHistoryModal from "@/components/settings/ChatHistoryModal";
import AgentTranscript from "./AgentTranscript";
import { isCommandDraft } from "./agentCommandEntries";
import PlanList from "./PlanList";
import type { AgentCommandMenuHandle } from "./AgentCommandMenu";
import { notifyInputStopped } from "./panel/inputActivity";
import { useAgentPanelAttachments } from "./panel/useAgentPanelAttachments";
import { AgentPanelHeader } from "./panel/AgentPanelHeader";
import { AgentHistoryDrawer } from "./panel/AgentHistoryDrawer";
import { AgentComposer } from "./panel/AgentComposer";
import { SubconversationBar } from "./panel/SubconversationBar";
import { RollbackNoticeBar } from "./panel/RollbackNoticeBar";

export default function AgentPanel() {
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
  const historyDrawerPresence = useAnimatedPresence(historyDrawerOpen);
  const [tasksDrawerOpen, setTasksDrawerOpen] = useState(false);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [rollbackNotice, setRollbackNotice] = useState<string | null>(null);
  const [tasksDrawerTab, setTasksDrawerTab] = useState<'agents' | 'jobs'>('agents');
  /** 用户主动发送后允许一次强制贴底；流式更新只跟随近底区。 */
  const userJustSentRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const commandMenuRef = useRef<AgentCommandMenuHandle>(null);
  const rollbackNoticeTimerRef = useRef<number | null>(null);
  const sendingRef = useRef(false);
  const activeSession = useSessionStore((s) => {
    return s.activeSessionId ? (s.sessions[s.activeSessionId] ?? null) : null;
  });
  const fetchConnections = useConnectionStore((s) => s.fetchConnections);
  const activeSessionId = activeSession?.id ?? null;
  const activeConfigId = activeSession?.configId;
  const {
    sendPrompt,
    stopActiveTask,
    mode,
    setMode,
    setInputDraft: setInput,
    isRunning,
    conversations,
    activeConversationId,
    newConversation,
    switchConversation,
    renameConversation,
    deleteConversation,
    setConversationPinned,
    setConversationModel,
    setConversationEffort,
    rollbackToMessage,
    activeUsageView,
    syncActiveToConnection,
  } = useAgent({ subscribeMessages: false, subscribeDraft: false });

  const tasks = useTaskStore((s) => s.tasks);
  const unreadCompletedConversations = useTaskStore(
    (s) => s.unreadCompletedConversations,
  );
  // 本会话是否正在手动压缩上下文（订阅而非直接读 store：压缩一开始就要立刻
  // 禁用发送键并显示原因，不能等第一条压缩事件把它带出来）。
  const isCompacting = useTaskStore((s) =>
    activeConversationId ? !!s.compacting[activeConversationId] : false,
  );

  // 子agent对话不在会话列表展示：只通过主对话的 task 卡片进入/返回
  const sessionConversations = useMemo(
    () =>
      Object.values(conversations).filter(
        (c) => c.connectionId === activeConfigId && !c.parentConversationId,
      ),
    [conversations, activeConfigId],
  );

  const canInteract = activeSession?.status === "connected";

  // 当前对话是否为子agent对话（subagent 工具派发）：输入区替换为"返回主对话"条
  const activeConversation = activeConversationId
    ? (conversations[activeConversationId] ?? null)
    : null;
  const isSubConversation = !!activeConversation?.parentConversationId;
  const parentConversationId = activeConversation?.parentConversationId ?? null;
  /**
   * 子 agent 派发信息：
   * - `mode`（plan 只读调研 / agent 读写执行）驱动输入区文案；
   * - `isLocal` 判定它是不是**本机**子任务（`local_subagent`）——本机子任务的
   *   `sessionId` 是哨兵值（`isLocalSessionId`，见 toolCatalog 的
   *   `LOCAL_SESSION_SENTINEL`），没有 SSH 会话。横条据此标「本机」，否则用户
   *   会以为这条子对话跑在某台服务器上（与移动端 `MobileAgentHost` 同口径）。
   */
  const subAgentDispatch = (() => {
    if (!activeConversationId) return { mode: "plan" as const, isLocal: false };
    const subTask = Object.values(tasks).find(
      (t) => t.conversationId === activeConversationId && t.parentTaskId,
    );
    return {
      mode: (subTask?.mode === "agent" ? "agent" : "plan") as "plan" | "agent",
      isLocal: isLocalSessionId(subTask?.sessionId),
    };
  })();
  const subAgentMode = subAgentDispatch.mode;

  // 图片支持按「当前会话实际生效模型」判定（会话记忆 → 全局最近使用），
  // 避免会话内切到非视觉模型时仍允许附图。普通派生值（随每次渲染重算，
  // 不能用 zustand selector——会话切换时 selector 不重跑）。
  const registry = useSettingsStore((s) => s.settings.llmRegistry);
  const visionEnabled = currentVision(registry, activeConversation?.modelId ?? null);

  const attachments = useAgentPanelAttachments({
    visionEnabled,
    canInteract,
    activeConversationId,
    setInput,
  });

  const handleBackToParent = useCallback(() => {
    if (parentConversationId) {
      void switchConversation(parentConversationId);
    }
  }, [parentConversationId, switchConversation]);

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  // SSH tab 切换时，把 Agent 聊天精准同步到对应 session 的对话
  useEffect(() => {
    if (!activeConfigId || !activeSessionId) return;
    void syncActiveToConnection(activeConfigId, activeSessionId);
  }, [activeConfigId, activeSessionId, syncActiveToConnection]);

  useEffect(
    () => () => {
      if (rollbackNoticeTimerRef.current !== null) {
        window.clearTimeout(rollbackNoticeTimerRef.current);
      }
    },
    [],
  );

  const handleSend = async () => {
    // 压缩中把消息发出去 = 消息会被随后落下的压缩卡盖到后面、再被归档边界
    // 从后续请求里抹掉（见 taskStore.compacting 的注释）。返回键与发送键同一
    // 判定；屏幕上常驻的原因说明负责让用户知道为什么没反应。
    if (isRunning || isCompacting || sendingRef.current) return;
    const prompt = useTaskStore.getState().inputDraft.trim();
    const images = visionEnabled ? attachments.pendingImages : [];
    if ((!prompt && images.length === 0) || !canInteract) return;
    if (!visionEnabled && attachments.pendingImages.length > 0) {
      attachments.clearPendingImages({ deleteDisk: true });
      attachments.showAttachHint("当前模型未开启「视觉 / 支持图片」");
      return;
    }
    sendingRef.current = true;
    userJustSentRef.current = true;
    const snapshotImages = images;
    const dataUrls = images.map((i) => i.dataUrl);
    const oldPersisted = images
      .map((i) => i.persistedPath)
      .filter((p): p is string => !!p);
    setInput("");
    notifyInputStopped();
    // 只清 UI 状态，blob URL 等成功后再 revoke；save 失败可原样回滚
    attachments.setPendingImages([]);
    try {
      await sendPrompt(
        activeSessionId!,
        prompt,
        activeConfigId,
        dataUrls,
        oldPersisted,
      );
      revokePendingImages(snapshotImages);
    } catch (err) {
      console.error("Failed to start task:", err);
      const stage = (err as Error & { stage?: string })?.stage;
      if (stage === "start_task") {
        // 消息（含新图）已进会话；旧落盘图已在 save 后删除
        revokePendingImages(snapshotImages);
        return;
      }
      // save 失败或其它：恢复输入与预览，旧落盘图保留
      setInput(prompt);
      attachments.setPendingImages(snapshotImages);
      userJustSentRef.current = false;
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    } finally {
      sendingRef.current = false;
    }
  };

  // ── `/` 命令面板 ─────────────────────────────────────────────────────
  // 输入以 "/" 开头且不含空格时激活（含空格视为普通文本，避免路径输入误弹）。
  // 任务运行中不唤出：手动压缩与运行中任务并发会造成替换竞态（对齐 DSH
  // compactNow 的 busy 语义），其它命令（模式切换）在运行中也没有意义。
  // 压缩中同样不唤出 —— 会话忙的两种情况走同一个 `conversationIsBusy`，
  // 顺带堵住「压缩中再点一次压缩」（两次摘要各写一张卡会破坏恒单卡）。
  // 键盘事件在打开时交给面板组件处理（↑↓/Enter/Esc/子菜单 Backspace）。
  const commandDraft = useTaskStore((s) => isCommandDraft(s.inputDraft));
  const commandMenuOpen =
    commandDraft &&
    (!activeConversationId || !conversationIsBusy(activeConversationId));

  const handleCompact = () => {
    if (!activeConversationId) return;
    // 压缩结果/失败会以消息卡片形式出现在会话列表里（compactConversation 内部处理）
    useConversationStore
      .getState()
      .compactConversation(activeConversationId)
      .catch((err) => {
        console.error("Failed to compact conversation:", err);
      });
  };

  // 「取消压缩」：中断正在跑的摘要调用（后端置位取消通道），随后走既有的
  // Skipped 分支把进行中的卡片转成「未完成：已取消」，会话占位随之释放。
  // 解锁交给 compactConversation 的 finally —— 这里提前放行会让「取消晚于摘要
  // 完成」的那次落库和新消息撞在一起。
  const handleCancelCompaction = () => {
    if (!activeConversationId) return;
    void useConversationStore
      .getState()
      .cancelCompaction(activeConversationId)
      .catch((err) => {
        console.error("Failed to cancel compaction:", err);
      });
  };

  const handleInsertSkill = (prompt: string) => {
    setInput(prompt);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (commandMenuOpen && commandMenuRef.current?.handleKeyDown(e)) {
      e.preventDefault();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const showRollbackNotice = useCallback((removedCount: number) => {
    setRollbackNotice(`已撤回 ${removedCount} 条消息，原消息已放回输入框`);
    if (rollbackNoticeTimerRef.current !== null) {
      window.clearTimeout(rollbackNoticeTimerRef.current);
    }
    rollbackNoticeTimerRef.current = window.setTimeout(() => {
      setRollbackNotice(null);
      rollbackNoticeTimerRef.current = null;
    }, 4200);
  }, []);

  const handleRollbackMessage = useCallback(async (message: AgentMessage) => {
    // 压缩中同样不许撤回：撤回会删掉压缩区间里的 DB 行，而这次压缩的卡片正按
    // 「提交那一刻的队尾」落位 —— 锚点被抽掉，落库要么失败要么落到错的位置。
    if (!activeConversationId || isRunning || isCompacting) return;
    try {
      const result = await rollbackToMessage(activeConversationId, message.id);
      setInput(result.prompt);

      // 先清当前预览（若有撤回恢复的落盘图也删掉）
      attachments.clearPendingImages({ deleteDisk: true });
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
            console.warn("Failed to restore image after rollback:", path, err);
            failedPaths.push(path);
          }
        }
        // 超出上限的路径也视为未进预览，删掉
        if (paths.length > MAX_ATTACH_IMAGES) {
          failedPaths.push(...paths.slice(MAX_ATTACH_IMAGES));
        }
        if (failedPaths.length > 0) {
          void attachments.deletePersistedPaths(failedPaths);
        }
        if (restored.length > 0) {
          attachments.setPendingImages(restored);
        } else if (paths.length > 0) {
          attachments.showAttachHint("原消息图片恢复失败");
        }
      } else if (paths.length > 0 && !visionEnabled) {
        // 未回到预览：清磁盘
        void attachments.deletePersistedPaths(paths);
        attachments.showAttachHint("当前模型未开启「视觉 / 支持图片」，图片未恢复");
      }

      showRollbackNotice(result.removedCount);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    } catch (err) {
      console.error("Failed to rollback message:", err);
    }
  }, [
    activeConversationId, isRunning, isCompacting, rollbackToMessage, setInput,
    attachments, visionEnabled, showRollbackNotice,
  ]);

  const handleCopyMessage = useCallback(async (message: AgentMessage) => {
    try {
      await writeText(message.content);
    } catch (err) {
      console.error("Failed to copy message:", err);
    }
  }, []);

  const handleStop = () => {
    stopActiveTask();
  };

  const handleNewConversation = async () => {
    if (!canInteract || !activeConfigId) return;
    try {
      await newConversation(activeSessionId!, activeConfigId);
      setHistoryDrawerOpen(false);
    } catch (err) {
      console.error("Failed to create conversation:", err);
    }
  };

  const handleSelectConversation = async (conversationId: string) => {
    try {
      await sessionConversationBindingManager.selectOrJumpToConversation(
        conversationId,
        activeSessionId,
      );
      setHistoryDrawerOpen(false);
    } catch (err) {
      console.error("Failed to switch conversation:", err);
    }
  };

  const handleHistoryClick = () => {
    if (canInteract) {
      setHistoryDrawerOpen((v) => !v);
    } else {
      setShowHistoryModal(true);
    }
  };

  const handleOpenTaskCenter = (tab: 'agents' | 'jobs') => {
    setTasksDrawerTab(tab);
    setTasksDrawerOpen(true);
  };

  return (
    <div
      data-region="agent-panel"
      className="relative flex flex-col h-full bg-zinc-900"
    >
      <AgentPanelHeader
        activeUsageView={activeUsageView}
        tasks={tasks}
        activeConversationId={activeConversationId}
        canInteract={canInteract}
        onNewConversation={handleNewConversation}
        onHistoryClick={handleHistoryClick}
        onOpenTaskCenter={handleOpenTaskCenter}
      />

      {/* Messages */}
      <AgentTranscript
        conversationId={activeConversationId}
        canInteract={canInteract}
        rollbackDisabled={isRunning || isCompacting}
        onRollback={handleRollbackMessage}
        onCopy={handleCopyMessage}
        userJustSentRef={userJustSentRef}
        emptyState={<>
          {!activeSession && (
            <div className="text-center text-zinc-500 text-sm mt-8">
              <p>请先连接 SSH 服务器。</p>
              <p className="mt-1">连接成功后即可使用智能助手。</p>
            </div>
          )}
          {activeSession?.status === "connecting" && (
            <div className="text-center text-zinc-500 text-sm mt-8">
              <p>正在连接 SSH 服务器...</p>
              <p className="mt-1">连接完成后将加载智能助手会话。</p>
            </div>
          )}
          {activeSession?.status === "error" && (
            <div className="text-center text-zinc-500 text-sm mt-8">
              <p>连接失败，请在标签栏重新连接。</p>
            </div>
          )}
          {activeSession?.status === "disconnected" && (
            <div className="text-center text-zinc-500 text-sm mt-8">
              <p>连接已断开，请在标签栏重新连接。</p>
            </div>
          )}
          {canInteract && !activeConversationId && (
            <div className="text-center text-zinc-500 text-sm mt-8">
              <p>暂无会话。</p>
              <p className="mt-1">点击左上角 + 新建会话。</p>
            </div>
          )}
          {canInteract && activeConversationId && (
            <div className="text-center text-zinc-500 text-sm mt-8">
              <p>暂无消息。</p>
              <p className="mt-1">描述您想要做的事情，智能助手将为您提供帮助。</p>
            </div>
          )}
        </>}
      />

      {/* PlanList - todolist rendered between messages and input */}
      <PlanList />

      {rollbackNotice && (
        <RollbackNoticeBar
          notice={rollbackNotice}
          onDismiss={() => setRollbackNotice(null)}
        />
      )}

      {/* Input area */}
      {isSubConversation ? (
        <SubconversationBar
          subAgentMode={subAgentMode}
          isLocal={subAgentDispatch.isLocal}
          title={activeConversation?.title ?? "子agent对话"}
          onBack={handleBackToParent}
        />
      ) : (
        <AgentComposer
          attachments={attachments}
          mode={mode}
          setMode={setMode}
          isRunning={isRunning}
          isCompacting={isCompacting}
          canInteract={canInteract}
          activeSessionStatus={activeSession?.status}
          commandMenuOpen={commandMenuOpen}
          commandMenuRef={commandMenuRef}
          inputRef={inputRef}
          onKeyDown={handleKeyDown}
          onInsertSkill={handleInsertSkill}
          onCompact={handleCompact}
          setInput={setInput}
          registry={registry}
          activeConversation={activeConversation}
          activeConversationId={activeConversationId}
          setConversationModel={setConversationModel}
          setConversationEffort={setConversationEffort}
          onSend={handleSend}
          onStop={handleStop}
          onCancelCompaction={handleCancelCompaction}
        />
      )}

      {/* History Drawer */}
      {historyDrawerPresence.mounted && (
        <AgentHistoryDrawer
          presence={historyDrawerPresence}
          onClose={() => setHistoryDrawerOpen(false)}
          sessionConversations={sessionConversations}
          activeConversationId={activeConversationId}
          tasks={tasks}
          unreadCompletedConversations={unreadCompletedConversations}
          onSelect={handleSelectConversation}
          onDelete={deleteConversation}
          onPin={setConversationPinned}
          onRename={renameConversation}
        />
      )}

      <ChatHistoryModal
        open={showHistoryModal}
        onClose={() => setShowHistoryModal(false)}
      />

      <AgentTasksDrawer
        open={tasksDrawerOpen}
        onClose={() => setTasksDrawerOpen(false)}
        initialTab={tasksDrawerTab}
      />
    </div>
  );
}
