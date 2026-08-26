import { useSessionStore } from './sessionStore';
import { useConversationStore } from './conversationStore';
import { useTaskStore } from './taskStore';
import type { Session } from '@/lib/types';

/**
 * SessionConversationBindingManager
 * 统一管理 SSH 会话（Session Tab）与 AI 对话（Conversation）的绑定、
 * 独占占用检测、跨 Tab 智能路由跳转以及生命周期清理。
 */
class SessionConversationBindingManager {
  /**
   * 查找某个对话当前是否被某个在线/活着的 SSH Session 独占占用。
   * 优先检查 taskStore 中该 conversation 是否有正在执行的 running task（绑定了特定 sessionId）；
   * 其次检查 sessionStore 中是否有在线 session 的 activeConversation 正好是该 conversationId。
   */
  public findOccupyingSession(conversationId: string): { sessionId: string; session: Session } | null {
    const sessionState = useSessionStore.getState();
    const liveSessions = sessionState.sessions;

    // 1. 优先检查正在运行的任务所绑定的 sessionId
    const taskStore = useTaskStore.getState();
    const runningTask = Object.values(taskStore.tasks).find(
      (t) =>
        t.conversationId === conversationId &&
        !!t.sessionId &&
        liveSessions[t.sessionId] &&
        liveSessions[t.sessionId].status === 'connected' &&
        (t.status === 'planning' || t.status === 'executing' || t.status === 'waiting_approval'),
    );
    if (runningTask && runningTask.sessionId) {
      const sess = liveSessions[runningTask.sessionId];
      if (sess) {
        return { sessionId: runningTask.sessionId, session: sess };
      }
    }

    // 2. 检查各 session 当前记忆/激活的 conversationId
    const convState = useConversationStore.getState();
    const bySession = convState.activeConversationBySession;

    for (const [sid, cid] of Object.entries(bySession)) {
      if (cid === conversationId) {
        const sess = liveSessions[sid];
        if (sess && (sess.status === 'connected' || sess.status === 'connecting')) {
          return { sessionId: sid, session: sess };
        }
      }
    }

    return null;
  }

  /**
   * 获取所有被在线 Session 占用的 conversationId 集合（用于排除已被占用的对话，避免多 Tab 抢同一个）
   */
  public getOccupiedConversationIds(excludeSessionId?: string): Set<string> {
    const occupied = new Set<string>();
    const sessionState = useSessionStore.getState();
    const liveSessions = sessionState.sessions;
    const convState = useConversationStore.getState();
    const bySession = convState.activeConversationBySession;

    // 1. 运行中任务占用的 conversation
    const taskStore = useTaskStore.getState();
    for (const t of Object.values(taskStore.tasks)) {
      if (
        t.sessionId &&
        t.sessionId !== excludeSessionId &&
        liveSessions[t.sessionId] &&
        liveSessions[t.sessionId].status === 'connected' &&
        (t.status === 'planning' || t.status === 'executing' || t.status === 'waiting_approval')
      ) {
        occupied.add(t.conversationId);
      }
    }

    // 2. 在线 session 绑定的 conversation
    for (const [sid, cid] of Object.entries(bySession)) {
      if (sid === excludeSessionId) continue;
      const sess = liveSessions[sid];
      if (sess && (sess.status === 'connected' || sess.status === 'connecting')) {
        occupied.add(cid);
      }
    }

    return occupied;
  }

  /**
   * 智能切换或跳转对话：
   * - 若目标 conversation 正在被另一个在线 Session A 占用（例如在 A 中正在运行或已打开）：
   *   → 智能切换终端 Tab 到 A 会话，并在 A 中激活该对话；
   * - 若目标 conversation 未被任何其他 Session 占用：
   *   → 在当前 Session 中打开该对话并记录绑定。
   *
   * @returns { switchedSession: boolean, targetSessionId: string | null }
   */
  public async selectOrJumpToConversation(
    conversationId: string,
    currentSessionId: string | null,
  ): Promise<{ switchedSession: boolean; targetSessionId: string | null }> {
    const occupying = this.findOccupyingSession(conversationId);

    if (occupying && occupying.sessionId !== currentSessionId) {
      // 目标对话已被其他在线 Tab（如 A）占用：智能跳回 A 会话
      const sessionStore = useSessionStore.getState();
      sessionStore.setActiveSession(occupying.sessionId);

      const convStore = useConversationStore.getState();
      await convStore.switchConversation(conversationId, occupying.sessionId);

      return { switchedSession: true, targetSessionId: occupying.sessionId };
    }

    // 未被其他 Tab 占用：在当前 session 中正常切入
    const convStore = useConversationStore.getState();
    await convStore.switchConversation(conversationId, currentSessionId ?? undefined);

    return { switchedSession: false, targetSessionId: currentSessionId };
  }

  /**
   * 当 SSH 会话连接成功时触发：
   * 1. 加载本连接的历史对话；
   * 2. 检查本 session 是否已有绑定的对话；
   * 3. 若无绑定对话，寻找一个「未被其他活着的 Tab 占用」的历史对话；
   * 4. 若所有历史对话都被其他在线 Tab 占用了（或该连接没有任何历史对话），自动新建属于当前 Tab 的专属独立会话，
   *    确保新 Tab 不会和已有 Tab 抢同一个会话。
   */
  public async onSessionConnected(connectionId: string, sessionId: string): Promise<string> {
    const convStore = useConversationStore.getState();
    await convStore.loadConnectionConversations(connectionId);

    const afterLoad = useConversationStore.getState();
    const currentBySession = afterLoad.activeConversationBySession[sessionId];

    if (currentBySession && afterLoad.conversations[currentBySession]) {
      // 本 session 已有明确记忆，直接同步
      await convStore.syncActiveToSession(sessionId, connectionId);
      return currentBySession;
    }

    // 查找本 connection 下所有主对话
    const occupiedIds = this.getOccupiedConversationIds(sessionId);
    const availableConvs = Object.values(afterLoad.conversations)
      .filter((c) => c.connectionId === connectionId && !c.parentConversationId)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    // 挑选一个未被其他在线 Tab 占用的对话
    const freeConv = availableConvs.find((c) => !occupiedIds.has(c.id));

    if (freeConv) {
      convStore.bindConversationToSession(sessionId, freeConv.id, connectionId);
      await convStore.syncActiveToSession(sessionId, connectionId);
      return freeConv.id;
    }

    // 所有现有会话都被其他在线会话占用了，或者没有任何会话：创建专属新会话
    const newId = await convStore.newConversation(sessionId, connectionId);
    return newId;
  }

  /**
   * 当 SSH 会话断开或关闭 Tab 时触发：
   * 清理该 session 的绑定关系，释放其对 conversation 的独占占用。
   */
  public onSessionDisconnected(sessionId: string, connectionId?: string): void {
    const convStore = useConversationStore.getState();
    convStore.unbindSessionConversation(sessionId);

    // 若该 connection 下已无任何在线 session，清理连接层级缓存
    if (connectionId) {
      const sessionStore = useSessionStore.getState();
      const stillActive = Object.values(sessionStore.sessions).some(
        (s) => s.id !== sessionId && s.configId === connectionId,
      );
      if (!stillActive) {
        convStore.clearConnectionConversations(connectionId);
      }
    }

    // 会话断开时，清理属于该 sessionId 的孤儿 running / waiting_approval tasks，
    // 并自动收敛 interaction 状态，防止断连后残留橙点/转圈
    const taskStore = useTaskStore.getState();
    const tasks = taskStore.tasks;
    let hasChanged = false;
    const updatedTasks = { ...tasks };
    for (const [tid, task] of Object.entries(tasks)) {
      if (task.sessionId === sessionId && (task.status === 'planning' || task.status === 'executing' || task.status === 'waiting_approval')) {
        updatedTasks[tid] = { ...task, status: 'cancelled' };
        hasChanged = true;
      }
    }
    if (hasChanged) {
      useTaskStore.setState({
        tasks: updatedTasks,
        activeTaskId: taskStore.activeTaskId && updatedTasks[taskStore.activeTaskId]?.status === 'cancelled' ? null : taskStore.activeTaskId,
        pendingApproval: null,
        pendingQuestion: null,
      });
    }
  }
}

export const sessionConversationBindingManager = new SessionConversationBindingManager();
export const sessionConversationManager = sessionConversationBindingManager;
