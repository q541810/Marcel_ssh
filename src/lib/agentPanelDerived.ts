// Agent 主面板（桌面 `AgentPanel` / 移动端 `MobileAgentHost`）共享的派生与
// 门控。此前这段逻辑在两端逐字各抄一份，改一处漏一处的风险收敛到这里。
//
// 只依赖类型与 `toolCatalog` 的哨兵判定，不 import store 模块（避免 lib 反向
// 依赖）；需要 store 数据的参数由调用方传入。

import type { AgentTask } from '@/lib/types';
import { isLocalSessionId } from '@/lib/toolCatalog';

/** taskStore.state 里本模块用到的切片（结构子集，调用处直接兼容）。 */
export interface TaskCompactingSlice {
  compacting: Record<string, true>;
}

/** 子 agent 派发信息（当前对话是子agent对话时输入区怎么呈现）。 */
export interface SubAgentDispatchInfo {
  /** plan 只读调研 / agent 读写执行 —— 驱动输入区文案。 */
  mode: 'plan' | 'agent';
  /**
   * 是不是**本机**子任务（`local_subagent`）——本机子任务的 `sessionId` 是
   * 哨兵值（`isLocalSessionId`，见 toolCatalog 的 `LOCAL_SESSION_SENTINEL`），
   * 没有 SSH 会话。横条据此标「本机」，否则用户会以为这条子对话跑在某台服务器上。
   */
  isLocal: boolean;
}

/**
 * 从任务表派生当前对话的子 agent 派发信息：找一条属于当前对话、带
 * `parentTaskId` 的任务（子agent工具派发的那条）。
 *
 * 判定只走哨兵值（与任务中心的会话标签同一口径），不查 sessionStore：`side`
 * 缺省（旧数据 / 远端子任务）不命中哨兵，行为与从前完全一致。没有
 * activeConversationId 或找不到子任务时回落 `{ mode: 'plan', isLocal: false }`。
 */
export function deriveSubAgentDispatch(
  tasks: Record<string, AgentTask>,
  activeConversationId: string | null | undefined,
): SubAgentDispatchInfo {
  const subTask = activeConversationId
    ? Object.values(tasks).find(
        (t) => t.conversationId === activeConversationId && t.parentTaskId,
      )
    : undefined;
  return {
    mode: (subTask?.mode === 'agent' ? 'agent' : 'plan') as 'plan' | 'agent',
    isLocal: isLocalSessionId(subTask?.sessionId),
  };
}

/**
 * 「本会话是否正在手动压缩上下文」的 store selector 工厂。
 *
 * 返回值交给 `useTaskStore(...)` 用：订阅而非直接读 store —— 压缩一开始就要
 * 立刻禁用发送键并显示原因，不能等第一条压缩事件把它带出来。无
 * activeConversationId 时恒 false。
 */
export function compactingSelectorOf(
  activeConversationId: string | null | undefined,
): (s: TaskCompactingSlice) => boolean {
  return (s) =>
    activeConversationId ? !!s.compacting[activeConversationId] : false;
}

/**
 * `/` 命令菜单的唤出门控：输入命中命令草稿，且当前没有进行中的对话。
 *
 * 任务运行中不唤出：手动压缩与运行中任务并发会造成替换竞态（对齐 DSH
 * compactNow 的 busy 语义），其它命令（模式切换）在运行中也没有意义。
 * 压缩中同样不唤出 —— 会话忙的两种情况走同一个 `conversationIsBusy`，
 * 顺带堵住「压缩中再点一次压缩」（两次摘要各写一张卡会破坏恒单卡）。
 *
 * `isBusy` 传 store 的 `conversationIsBusy`（lib 不反向 import store，由
 * 调用方注入）。
 */
export function canOpenCommandMenu(
  commandDraft: boolean,
  activeConversationId: string | null | undefined,
  isBusy: (conversationId: string) => boolean,
): boolean {
  return (
    commandDraft &&
    (!activeConversationId || !isBusy(activeConversationId))
  );
}
