import { useSessionStore } from './sessionStore';
import { useConversationStore } from './conversationStore';
import { useTaskStore, finalizeTaskLocally } from './taskStore';
import { isTaskBusy } from '@/lib/agentStatus';
import { isLocalSessionId } from '@/lib/toolCatalog';
import type { AgentConversation, Session } from '@/lib/types';
import { agentCreateConversation } from '@/lib/tauri';

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
    //    （本机子任务的 sessionId 是哨兵值，不是会话：下面 `liveSessions[...]`
    //    本来就查不到它，这里再显式排除一次，语义上写清「哨兵不当占用者」）
    const taskStore = useTaskStore.getState();
    const runningTask = Object.values(taskStore.tasks).find(
      (t) =>
        t.conversationId === conversationId &&
        !!t.sessionId &&
        !isLocalSessionId(t.sessionId) &&
        liveSessions[t.sessionId] &&
        liveSessions[t.sessionId].status === 'connected' &&
        isTaskBusy(t.status),
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
    //    （同样排除本机子任务的哨兵值：它不属于任何 SSH 会话，也就谈不上
    //    「被某个 Tab 占用」）
    const taskStore = useTaskStore.getState();
    for (const t of Object.values(taskStore.tasks)) {
      if (
        t.sessionId &&
        !isLocalSessionId(t.sessionId) &&
        t.sessionId !== excludeSessionId &&
        liveSessions[t.sessionId] &&
        liveSessions[t.sessionId].status === 'connected' &&
        isTaskBusy(t.status)
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

  /** 连接和删除后恢复共用同一条分配规则：同连接、主对话、未被别的在线标签占用。 */
  private findAvailableConversation(connectionId: string, sessionId: string): AgentConversation | undefined {
    const occupiedIds = this.getOccupiedConversationIds(sessionId);
    return Object.values(useConversationStore.getState().conversations)
      .filter((c) => c.connectionId === connectionId && !c.parentConversationId)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .find((c) => !occupiedIds.has(c.id));
  }

  /**
   * 删除后的恢复只准备候选，绝不顺带激活页面。
   * 调用方在消息就绪后核对选择意图和占用，再一次提交绑定及展示状态。
   */
  public async prepareReplacementAfterDeletion(
    sessionId: string,
    connectionId: string,
    stillCurrent: () => boolean,
  ): Promise<{ conversation: AgentConversation; created: boolean } | null> {
    if (!stillCurrent()) return null;
    const available = this.findAvailableConversation(connectionId, sessionId);
    if (available) return { conversation: available, created: false };
    const id = await agentCreateConversation(sessionId);
    // 已发出的建库不能撤销；用户已切走时仅留下未激活的空历史，下次列表加载可见。
    if (!stillCurrent()) return null;
    const now = new Date().toISOString();
    return {
      conversation: { id, connectionId, title: '新会话', createdAt: now, updatedAt: now },
      created: true,
    };
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
      // 绑定先行：切 session 会立刻触发 AgentPanel 的 syncActiveToSession，
      // 而它读的是这份绑定关系。晚写的话那条同步会按旧绑定自己挑一条对话，
      // 并且它比本次切换更晚进入（代际更新）→ 用户点的这条会被丢掉。
      convStore.bindConversationToSession(occupying.sessionId, conversationId);
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
    const freeConv = this.findAvailableConversation(connectionId, sessionId);

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

    // 会话断开时，收尾属于该 sessionId 的孤儿 running / waiting_approval tasks：
    // 界面上的转圈与「待审批」标注都由任务状态驱动，不收尾就会一直亮着。
    //
    // **必须**经 `finalizeTaskLocally`（而不是就地改 status）：只改 status 会
    // 同时丢掉三件收尾 —— 在飞卡片永久转圈、流通道没人拆（晚到的终态事件会把
    // **新回合**的锚点写成 completed、并删掉新任务正在飞的工具卡）、回合收尾
    // 状态不写（折叠判定只能拿 running 去猜）。
    //
    // 同一件事的另一半在后端：断连观察者按会话级联停止这些任务（
    // `agent::manager::stop_task_cascade`，与停止按钮同一套语义，含全部子 agent），
    // 所以这里标的「已取消」是真的取消了 —— 命令、后台作业、在飞的 LLM 调用都
    // 随之收场。
    //
    // 前端**不**为这些任务下发停止命令：断的是**这一个** SSH 会话，多机任务的
    // 子 agent 可能跑在别的机器上（`multi_host`），按单个任务下发会连它们一起
    // 误杀；后端观察者按「会话 → 任务树」停，边界才是对的。
    //
    // 为什么还要在本地同步收尾一遍，而不是等后端那条 `StreamEvent::Cancelled`
    // 自己落下来：通道必须**先**拆 —— 晚到的终态事件会按「自然结束」处理，把新
    // 回合的锚点写成 completed、并删掉新任务正在飞的工具卡。本地收尾之后那条
    // 事件在界面上就没有接收端了（后端仍会照常落库）。
    const taskStore = useTaskStore.getState();
    for (const [tid, task] of Object.entries(taskStore.tasks)) {
      if (task.sessionId === sessionId && isTaskBusy(task.status)) {
        finalizeTaskLocally(tid, 'cancelled');
      }
    }
  }
}

export const sessionConversationBindingManager = new SessionConversationBindingManager();
export const sessionConversationManager = sessionConversationBindingManager;
