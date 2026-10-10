import {
  useState,
  useRef,
  useEffect,
  useMemo,
  useCallback,
} from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
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
import {
  canOpenCommandMenu,
  compactingSelectorOf,
  deriveSubAgentDispatch,
} from "@/lib/agentPanelDerived";
import { dockPanelOf } from "@/lib/workspaceLayout";
import { currentVision } from "@/lib/llmRegistry";
import type { AgentMessage } from "@/lib/types";
import ChatHistoryModal from "@/components/settings/ChatHistoryModal";
import AgentTranscript from "./AgentTranscript";
import { isCommandDraft } from "./agentCommandEntries";
import PlanList from "./PlanList";
import type { AgentCommandMenuHandle } from "./AgentCommandMenu";
import { notifyInputStopped } from "./panel/inputActivity";
import { useAgentAttachments } from "@/hooks/useAgentAttachments";
import { useAgentDraftActions } from "@/hooks/useAgentDraftActions";
import { EMPTY_DRAFT, useAgentDraftStore } from "@/stores/agentDraftStore";
import ContentWidthHandles from "./panel/ContentWidthHandles";
import {
  agentContentMaxCss,
  readChatWidthPreference,
  resolveAgentContentWidth,
  writeChatWidthPreference,
} from "@/lib/chatContentWidth";
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
  const activeSession = useSessionStore((s) => {
    return s.activeSessionId ? (s.sessions[s.activeSessionId] ?? null) : null;
  });
  const fetchConnections = useConnectionStore((s) => s.fetchConnections);
  const activeSessionId = activeSession?.id ?? null;
  const activeConfigId = activeSession?.configId;
  const {
    stopActiveTask,
    mode,
    setMode,
    setInputDraft: setInput,
    isRunning,
    conversations,
    activeConversationId,
    draftKey,
    draftConversationId,
    draftSendUnavailableReason,
    newConversation,
    switchConversation,
    renameConversation,
    deleteConversation,
    setConversationPinned,
    setConversationModel,
    setConversationEffort,
    activeUsageView,
    syncActiveToConnection,
  } = useAgent({ subscribeMessages: false, subscribeDraft: false });

  const tasks = useTaskStore((s) => s.tasks);
  const unreadCompletedConversations = useTaskStore(
    (s) => s.unreadCompletedConversations,
  );
  // 本会话是否正在手动压缩上下文（订阅而非直接读 store：压缩一开始就要立刻
  // 禁用发送键并显示原因，不能等第一条压缩事件把它带出来）。
  const isCompacting = useTaskStore(compactingSelectorOf(activeConversationId));

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
   * - `isLocal` 判定它是不是**本机**子任务 —— 横条据此标「本机」，否则用户
   *   会以为这条子对话跑在某台服务器上。
   *
   * 派生逻辑与移动端 `MobileAgentHost` 共用 `lib/agentPanelDerived` 的
   * `deriveSubAgentDispatch`（哨兵值口径等细节见其注释）。
   */
  const subAgentDispatch = deriveSubAgentDispatch(tasks, activeConversationId);
  const subAgentMode = subAgentDispatch.mode;

  // 图片支持按「当前会话实际生效模型」判定（会话记忆 → 全局最近使用），
  // 避免会话内切到非视觉模型时仍允许附图。普通派生值（随每次渲染重算，
  // 不能用 zustand selector——会话切换时 selector 不重跑）。
  const registry = useSettingsStore((s) => s.settings.llmRegistry);
  const workspaceLayout = useSettingsStore((s) => s.settings.workspaceLayout);
  const visionEnabled = currentVision(registry, activeConversation?.modelId ?? null);

  // ── 内容列宽度（参考 DSH ui-conversation 的 ConversationRoot）──
  // 仅「Agent 占主区域」布局限宽（自适应 clamp，拖拽偏好可覆盖）；dock 里的
  // Agent **永远不限宽**——内容列宽就是 dock 自己的宽（拖中间分隔条调），
  // 拖拽偏好在这个布局下不生效（哪怕设过），切回主区域时仍在。把手拖拽实时
  // 发布到根上的 --agent-content-max，提交才落 localStorage；双击把手复位到
  // 自适应宽度。
  const agentRootRef = useRef<HTMLDivElement>(null);
  const chatWidthLimitActive = dockPanelOf(workspaceLayout) === 'terminal';
  const publishContentWidth = useCallback(() => {
    const root = agentRootRef.current;
    if (!root) return;
    const column = root.clientWidth;
    if (!Number.isFinite(column) || column <= 0) return;
    root.style.setProperty(
      '--agent-content-max',
      agentContentMaxCss(column, readChatWidthPreference(), chatWidthLimitActive),
    );
  }, [chatWidthLimitActive]);
  useEffect(() => {
    const root = agentRootRef.current;
    if (!root) return;
    publishContentWidth();
    const observer = new ResizeObserver(() => publishContentWidth());
    observer.observe(root);
    return () => observer.disconnect();
  }, [publishContentWidth]);
  const handleContentWidthStart = useCallback(() => {
    const root = agentRootRef.current;
    return resolveAgentContentWidth(root ? root.clientWidth : 0, readChatWidthPreference());
  }, []);
  const handleContentWidthDrag = useCallback((width: number) => {
    const root = agentRootRef.current;
    if (!root) return;
    root.style.setProperty(
      '--agent-content-max',
      `${resolveAgentContentWidth(root.clientWidth, width)}px`,
    );
  }, []);
  const handleContentWidthCommit = useCallback((width: number) => {
    const root = agentRootRef.current;
    if (!root) return;
    writeChatWidthPreference(resolveAgentContentWidth(root.clientWidth, width));
  }, []);
  const handleContentWidthEnd = useCallback(() => {
    publishContentWidth();
  }, [publishContentWidth]);
  const handleContentWidthReset = useCallback(() => {
    writeChatWidthPreference(null);
    publishContentWidth();
  }, [publishContentWidth]);

  const attachments = useAgentAttachments({
    visionEnabled,
    canInteract,
    conversationId: draftConversationId,
    sessionId: activeSessionId,
    subscribeText: false,
    sendUnavailableReason: draftSendUnavailableReason,
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

  // ── `/` 命令面板 ─────────────────────────────────────────────────────
  // 输入以 "/" 开头且不含空格时激活（含空格视为普通文本，避免路径输入误弹）。
  // 唤出门控（任务运行中/压缩中不唤出，理由见共享函数注释）与移动端
  // `MobileAgentHost` 共用 `canOpenCommandMenu`。
  // 键盘事件在打开时交给面板组件处理（↑↓/Enter/Esc/子菜单 Backspace）。
  const commandDraft = useAgentDraftStore((s) => isCommandDraft((s.drafts[draftKey] ?? EMPTY_DRAFT).text));
  const commandMenuOpen = canOpenCommandMenu(
    commandDraft,
    activeConversationId,
    conversationIsBusy,
  );

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
    setRollbackNotice(`已撤回 ${removedCount} 条消息，文字与附件已恢复到草稿`);
    if (rollbackNoticeTimerRef.current !== null) {
      window.clearTimeout(rollbackNoticeTimerRef.current);
    }
    rollbackNoticeTimerRef.current = window.setTimeout(() => {
      setRollbackNotice(null);
      rollbackNoticeTimerRef.current = null;
    }, 4200);
  }, []);

  const { send: handleSend, rollback: handleRollbackMessage, sending } = useAgentDraftActions({
    attachments,
    sessionId: activeSessionId,
    connectionId: activeConfigId,
    conversationId: draftConversationId,
    canInteract,
    userJustSentRef,
    onRollback: showRollbackNotice,
    onSend: notifyInputStopped,
  });

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
      ref={agentRootRef}
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
        rollbackDisabled={isRunning || isCompacting || sending}
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

      {chatWidthLimitActive && (
        <ContentWidthHandles
          onStart={handleContentWidthStart}
          onDrag={handleContentWidthDrag}
          onCommit={handleContentWidthCommit}
          onEnd={handleContentWidthEnd}
          onReset={handleContentWidthReset}
        />
      )}
    </div>
  );
}
