// 任务/作业中心的会话标签与跳转守卫 —— 桌面 `AgentTasksDrawer` 与移动端
// `MobileActiveAgentsSheet` 共享（此前两端各抄一份且口径漂移：移动端有「幽灵
// 会话」反查与跳转守卫，桌面没有。现收敛到此处，两端同一份逻辑、同一套措辞）。
//
// 只依赖 stores 给出的原始数据形状（不 import store 模块，避免 lib 反向依赖），
// 调用方从各自的 store 订阅里把快照传进来。

import type {
  AgentConversation,
  AgentTask,
  SavedConnection,
  Session,
} from '@/lib/types';
import { isLocalSessionId } from '@/lib/toolCatalog';

/** 任务中心标签/跳转依赖的只读数据快照（都是 store 里的原始形状，不另造）。 */
export interface TaskCenterCatalog {
  sessions: Record<string, Session>;
  connections: SavedConnection[];
  conversations: Record<string, AgentConversation>;
  tasks: Record<string, AgentTask>;
}

/** 会话在 store 里时的显示名：连接名（按 configId 反查）> connectionId > 会话 id。 */
function sessionDisplayLabel(
  session: Session,
  connections: SavedConnection[],
): string {
  const conn = session.configId
    ? connections.find((c) => c.id === session.configId)
    : null;
  return conn?.name || session.connectionId || session.id;
}

/**
 * Agent 任务卡片上的会话标签。
 *
 * - 本机子任务（local_subagent）：sessionId 是哨兵值，没有 SSH 会话可查 ——
 *   不查了，直接说清它在本机跑（查下去只会落成「未知会话」/「自动连接的目标机」）。
 * - 会话在 sessionStore 里：显示连接名。
 * - 会话不在 sessionStore 里（多机自动拉起的「幽灵会话」不在前端 sessionStore）：
 *   用对话归属的 connectionId 反查可读名，显示 `「xxx（自动连接）」`，避免落成
 *   「未知会话」；反查不到连接时兜底「自动连接的目标机」。
 */
export function getSessionLabel(
  catalog: TaskCenterCatalog,
  task: AgentTask,
): string {
  const { sessions, connections, conversations, tasks } = catalog;
  if (isLocalSessionId(task.sessionId)) return '本机';
  const { sessionId } = task;
  const session = sessions[sessionId];
  if (!session) {
    const viaConv = Object.values(conversations).find((c) => {
      const taskOfSession = Object.values(tasks).find(
        (t) => t.sessionId === sessionId && t.conversationId === c.id,
      );
      return !!taskOfSession;
    });
    const connFromConv = viaConv?.connectionId
      ? connections.find((c) => c.id === viaConv.connectionId)
      : null;
    if (connFromConv) return `${connFromConv.name}（自动连接）`;
    return '自动连接的目标机';
  }
  return sessionDisplayLabel(session, connections);
}

/**
 * 作业专用会话标签：会话已关闭（前端 sessions 已删除，但后端作业仍保留）时，
 * 显示会话 ID + 关闭提示，不冒充未知会话。
 *
 * 本机作业（`local_bash(run_in_background: true)`，id 形如 `local_job_N`）的
 * `sessionId` 是哨兵值，本来就没有会话可查 —— 与 `getSessionLabel` 同一口径，
 * 直接说清它在本机跑。漏了这条特判会落成
 * 「local（该任务对应会话已关闭）」：把一条**正在跑**的本机作业说成「会话已
 * 关闭」，用户会以为它废了。
 */
export function getJobSessionLabel(
  catalog: Pick<TaskCenterCatalog, 'sessions' | 'connections'>,
  sessionId: string,
): string {
  if (isLocalSessionId(sessionId)) return '本机';
  const session = catalog.sessions[sessionId];
  if (!session) return `${sessionId}（该任务对应会话已关闭）`;
  return sessionDisplayLabel(session, catalog.connections);
}

/**
 * 点击任务卡片要不要把 activeSessionId 切到该任务的终端会话。
 *
 * - 本机子任务没有 SSH 会话（sessionId 是哨兵值）：把它当会话切过去只会让
 *   activeSessionId 指向一个不存在的终端标签 —— 不切（只切到它的子对话，
 *   过程一样看得到，「本机」字样在卡片上，见 getSessionLabel）。
 * - 幽灵会话（多机自动拉起）不在 sessionStore：同样没有终端标签可切 —— 不切。
 * - 其余：已经是当前会话、或 sessionId 为空时不切。
 */
export function canJumpToSession(
  sessions: Record<string, Session>,
  task: AgentTask,
  activeSessionId: string | null | undefined,
): boolean {
  return (
    !isLocalSessionId(task.sessionId) &&
    !!task.sessionId &&
    task.sessionId !== activeSessionId &&
    !!sessions[task.sessionId]
  );
}
