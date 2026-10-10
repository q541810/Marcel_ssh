import { useCallback, useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useTaskStore, type StartTaskOptions } from '@/stores/taskStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useSessionStore } from '@/stores/sessionStore';
import { draftConversationIdFor, draftKeyFor, EMPTY_DRAFT, useAgentDraftStore } from '@/stores/agentDraftStore';
import { bus } from '@/plugins/injection/bus';
import { isTaskBusy } from '@/lib/agentStatus';
import { conversationUsageView } from '@/lib/tokenUsage';
import type { AgentMessage } from '@/lib/types';

// 缺少消息缓存时也返回稳定引用；这里只读取，不向 store 补写/清空旧数据。
const EMPTY_MESSAGES: AgentMessage[] = [];

export function useAgent({ subscribeMessages = true, subscribeDraft = true } = {}) {
  const conversation = useConversationStore(useShallow((s) => ({
    // 会话列表由双端 UI 展示，元数据变化仍须响应；消息只订阅当前会话的桶。
    conversations: s.conversations,
    activeConversationId: s.activeConversationId,
    activeConversationBySession: s.activeConversationBySession,
    messages: subscribeMessages && s.activeConversationId
      ? (s.messages[s.activeConversationId] ?? EMPTY_MESSAGES)
      : EMPTY_MESSAGES,
    newConversation: s.newConversation,
    switchConversation: s.switchConversation,
    loadConversation: s.loadConversation,
    renameConversation: s.renameConversation,
    deleteConversation: s.deleteConversation,
    setConversationPinned: s.setConversationPinned,
    setConversationModel: s.setConversationModel,
    setConversationEffort: s.setConversationEffort,
    rollbackToMessage: s.rollbackToMessage,
    loadConnectionConversations: s.loadConnectionConversations,
    syncActiveToConnection: s.syncActiveToConnection,
    syncActiveToSession: s.syncActiveToSession,
  })));
  const { activeConversationId } = conversation;
  const { activeSessionId, activeConfigId } = useSessionStore(useShallow((s) => ({
    activeSessionId: s.activeSessionId,
    activeConfigId: s.activeSessionId ? s.sessions[s.activeSessionId]?.configId : undefined,
  })));
  const boundId = activeSessionId ? conversation.activeConversationBySession[activeSessionId] : undefined;
  const draftConversationId = draftConversationIdFor({
    activeConversationId,
    conversations: conversation.conversations,
    activeConversationBySession: conversation.activeConversationBySession,
    activeSessionId,
    activeConfigId,
  });
  const draftSyncing = !!activeSessionId && !!(activeConversationId || boundId) && !draftConversationId;
  const draftKey = draftKeyFor(draftConversationId, activeSessionId);
  const inputDraft = useAgentDraftStore((s) =>
    subscribeDraft ? (s.drafts[draftKey] ?? EMPTY_DRAFT).text : '',
  );
  const setInputDraft = useCallback((text: string | ((previous: string) => string)) => {
    useAgentDraftStore.getState().setText(draftKey, text);
  }, [draftKey]);
  const task = useTaskStore(useShallow((s) => ({
    activeTask: s.activeTaskId ? (s.tasks[s.activeTaskId] ?? null) : null,
    activeUsage: activeConversationId ? s.usageByConversation[activeConversationId] : undefined,
    mode: s.mode,
    startTask: s.startTask,
    stopTask: s.stopTask,
    setMode: s.setMode,
  })));
  const { activeTask, startTask, stopTask } = task;

  // 当前会话的用量读数：实时事件优先、落库数据兜底（重启后打开会话走后者）。
  // 合成规则只在 `lib/tokenUsage.ts` 里写一遍，桌面与移动端共用。
  const activeConversation = activeConversationId
    ? conversation.conversations[activeConversationId]
    : undefined;
  const activeUsageView = useMemo(
    () => conversationUsageView(task.activeUsage, activeConversation),
    [task.activeUsage, activeConversation],
  );

  const isRunning = activeTask ? isTaskBusy(activeTask.status) : false;

  // ── Plugin agent-activity bridge ─────────────────────────────────────
  // Emits `ui://agent-activity` (running bool only — never task content) so
  // plugins (e.g. a desktop pet) can mirror the main UI's run indicator
  // (the red stop button). Same source as the button: task status is
  // non-terminal (planning / executing / waiting_approval). Fires on
  // mount and whenever the running state changes.
  useEffect(() => {
    bus.emit('ui://agent-activity', { running: isRunning });
  }, [isRunning]);

  const sendPrompt = useCallback(
    async (
      sessionId: string,
      prompt: string,
      connectionId?: string,
      imageDataUrls?: string[],
      replaceImagePaths?: string[],
      options?: StartTaskOptions,
    ) => {
      return startTask(sessionId, prompt, connectionId, imageDataUrls, replaceImagePaths, options);
    },
    [startTask],
  );

  const stopActiveTask = useCallback(async () => {
    if (activeTask) {
      return stopTask(activeTask.id);
    }
  }, [activeTask, stopTask]);

  return {
    ...conversation,
    activeTask,
    isRunning,
    mode: task.mode,
    draftKey,
    draftConversationId,
    draftSendUnavailableReason: draftSyncing ? '会话尚未就绪，可继续编辑并添加附件' : null,
    inputDraft,
    /** 当前会话的用量读数（含子 agent）；无会话/无数据时为 null。 */
    activeUsageView,
    sendPrompt,
    stopActiveTask,
    setMode: task.setMode,
    setInputDraft,
  };
}
