import { create } from 'zustand';
import type {
  AgentMessage,
  AgentConversation,
  StoredMessage,
  TurnState,
} from '@/lib/types';
import * as tauri from '@/lib/tauri';
import type { AgentCompactResult } from '@/lib/tauri';
import { getErrorMessage } from '@/lib/errors';
import {
  storedMessageToAgentMessage,
  clearIntermediateReasoning,
  compactionCheckpoint,
} from './messageConversion';
import { useTaskStore } from './taskStore';
import { useTurnFoldStore } from './turnFoldStore';
import { useSettingsStore } from './settingsStore';
import { effectiveModelId } from '@/lib/llmRegistry';
import { interruptNoticeKind, type InterruptNoticeKind } from '@/lib/toolCatalog';
import { isTaskBusy } from '@/lib/agentStatus';
import { withTailTurnState } from '@/lib/agentTurnFold';
import { attachStreamListener, cleanupTaskListeners } from './agentStreamManager';
import { getStreamState, setStreamState } from './agentStreamHandlers';

export interface ConversationState {
  conversations: Record<string, AgentConversation>;
  messages: Record<string, AgentMessage[]>;
  /** 记录当前会话在活跃切片之前是否还有更早的历史消息可供加载 */
  hasEarlierMessages: Record<string, boolean>;
  activeConversationId: string | null;
  /** 每个 connection 上次选中的对话，兼容跨机器恢复 */
  activeConversationByConnection: Record<string, string>;
  /** 每个 SSH session 独占绑定的活跃对话，切 SSH Tab 时精准恢复 */
  activeConversationBySession: Record<string, string>;

  addMessage: (message: AgentMessage) => void;
  clearMessages: () => void;
  newConversation: (sessionId: string, connectionId: string) => Promise<string>;
  switchConversation: (conversationId: string, sessionId?: string) => Promise<void>;
  loadConversation: (conversationId: string, sessionId?: string) => Promise<void>;
  /** 加载当前会话更早的归档历史消息并向前拼接入当前消息流 */
  loadEarlierHistory: (conversationId: string) => Promise<void>;
  bindConversationToSession: (sessionId: string, conversationId: string, connectionId?: string) => void;
  unbindSessionConversation: (sessionId: string) => void;
  renameConversation: (conversationId: string, title: string) => Promise<void>;
  /** 置顶/取消置顶会话（列表里浮到最上方；不改 updatedAt）。 */
  setConversationPinned: (conversationId: string, pinned: boolean) => Promise<void>;
  /**
   * 设置会话级模型（**仅内存**：后端 session_models + 本地 conv.modelId）。
   * modelId 非空 = 固定本会话用该模型，**顺带更新全局「最近使用」并落盘**；
   * null = 清除本会话记忆，回落全局最近使用。
   */
  setConversationModel: (conversationId: string, modelId: string | null) => Promise<void>;
  /**
   * 设置会话级思考强度（内存 + 落盘：后端 session_efforts +
   * conversations.efforts_json，**重启后记住**；本地 conv.reasoningEffort）。
   * 档位按「会话 × 模型」双维记忆——归属当前生效模型（会话记忆 → 全局
   * 最近使用 → 首个），切到别的模型各自记忆、互不污染。档位字符串须在该
   * 模型 reasoningEfforts 声明内（UI 只列声明档位）；null = 清除该
   * (会话, 模型) 记忆，回落模型自身默认。不更新全局设置。
   */
  setConversationEffort: (
    conversationId: string,
    reasoningEffort: string | null,
  ) => Promise<void>;
  deleteConversation: (conversationId: string) => Promise<void>;
  rollbackToMessage: (
    conversationId: string,
    messageId: string,
  ) => Promise<{ prompt: string; removedCount: number; imagePaths: string[] }>;
  clearConnectionConversations: (connectionId: string) => void;
  loadConnectionConversations: (connectionId: string) => Promise<void>;
  /** 将 UI 上的 active 对话切换到指定 SSH session / connection */
  syncActiveToSession: (sessionId: string, connectionId: string) => Promise<void>;
  /** 将 UI 上的 active 对话切换到指定 connection（保留向后兼容） */
  syncActiveToConnection: (connectionId: string, sessionId?: string) => Promise<void>;
  getCurrentMessages: () => AgentMessage[];

  ensureConversation: (sessionId: string, connectionId: string, fallbackTitle: string) => Promise<string>;
  appendMessages: (conversationId: string, messages: AgentMessage[]) => void;
  updateConversationMessages: (conversationId: string, updater: (messages: AgentMessage[]) => AgentMessage[]) => void;
  /**
   * 手动压缩上下文（命令面板「压缩上下文」）：调用后端触发一次原有压缩
   * 管线，返回统计结果。压缩只在后端内存副本上发生、**不写 DB**（原始
   * 历史保留）。前端在消息列表插入"压缩中"占位，完成后原位更新为
   * 压缩完成卡片（复用 CompactionCard）/ 未完成文案 / 失败文案。
   */
  compactConversation: (conversationId: string) => Promise<AgentCompactResult>;
  /**
   * 取消该会话正在跑的手动压缩（压缩中的「取消压缩」按钮）。返回「确实取消了一次
   * 在册压缩」——`false` 只说明这次点晚了（事件已到、命令已返回），不是错误。
   *
   * **不在这里解锁**：占位要等 `compactConversation` 的 `finally` 才释放。摘要调用
   * 可能刚好在取消到达之前跑完，那种情况下它仍会落库（`select!` 只包住进行中的
   * 请求），这时放进一条新消息就又踩回原来的坑。
   */
  cancelCompaction: (conversationId: string) => Promise<boolean>;
  /**
   * 注册 subagent 工具派发的子agent对话：插入 conversation 条目 + 骨架消息
   * （user=prompt、assistant=loading 占位）。子agent流式 listener 挂上后
   * 会实时更新该对话；不改变当前 active 对话。
   * 返回骨架 loading 消息 id（供 attachStreamListener 使用）；已注册过时返回 null。
   */
  registerSubConversation: (
    conversationId: string,
    connectionId: string,
    title: string,
    subTaskId: string,
    prompt: string,
    parentConversationId: string,
  ) => string | null;
  clearAllAssistantFlags: (conversationId?: string) => void;
  clearExecutingToolFlags: () => void;
  markAbortedToolFlags: (conversationId?: string) => void;
  /** 把回合收尾状态写到该对话尾回合的锚点（最后一条 user 消息）上。
   *  与后端 `messages.turn_state` 同一落点；仅 completed 允许折叠回合。 */
  markTailTurnState: (conversationId: string, state: TurnState) => void;
  buildLlmHistory: (conversationId: string) => Array<{
    role: string;
    content: string;
    reasoningContent?: string;
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    toolCallId?: string;
    imagePaths?: string[];
    dbId?: string;
  }>;
}

function rememberActiveForConnection(
  byConnection: Record<string, string>,
  connectionId: string,
  conversationId: string,
): Record<string, string> {
  if (byConnection[connectionId] === conversationId) return byConnection;
  return { ...byConnection, [connectionId]: conversationId };
}

function pickPreferredConversationId(
  conversations: Record<string, AgentConversation>,
  connectionId: string,
  rememberedId: string | undefined,
): string | null {
  // 排除子agent对话：切 SSH tab 时不自动恢复进子对话
  if (
    rememberedId &&
    conversations[rememberedId]?.connectionId === connectionId &&
    !conversations[rememberedId]?.parentConversationId
  ) {
    return rememberedId;
  }
  const sorted = Object.values(conversations)
    .filter((c) => c.connectionId === connectionId && !c.parentConversationId)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return sorted[0]?.id ?? null;
}

type LlmHistoryItem = {
  role: string;
  content: string;
  reasoningContent?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  toolCallId?: string;
  imagePaths?: string[];
  /** 持久化消息的 DB row id（统一 id 域）：后端据此给 loop 消息带 db_id，
   *  压缩的 tail_db_id 指针依赖它（load 的消息必有；运行中消息由后端 save 回填）。 */
  dbId?: string;
};

/**
 * LLM 协议要求：assistant 消息的 tool_calls 必须全部被紧随的 tool 消息回复。
 * 应用重启/崩溃（tool 执行中进程退出）会在历史里留下未闭合的 tool_calls ——
 * assistant(tool_calls) 后没有对应 tool 回复，直接发送会 400
 * ("must be followed by tool messages responding to each tool_call_id")。
 * 发送前做一次闭合校验：
 * - 全部已回复（正常历史 / 用户停止任务后后端补的 aborted tool 消息）：原样保留
 * - 部分已回复：toolCalls 过滤为已回复子集（按 id 匹配，保持原顺序）
 * - 全部未回复且 content 非空：移除 toolCalls，降级为纯 assistant 文本
 * - 全部未回复且 content 为空：整条移除（避免空消息）
 */
function closeToolCallGroups(output: LlmHistoryItem[]): LlmHistoryItem[] {
  const result: LlmHistoryItem[] = [];
  let openIdx: number | null = null;
  let replied = new Set<string>();

  const settle = () => {
    if (openIdx == null) return;
    // 先保存局部 idx 与 replied 快照：openIdx/replied 重置后再用会导致
    // result[null] 附加 'null' 属性（JSON 不可见但 toEqual 失败）以及
    // kept 恒为空（闭合组被误判未闭合而误裁剪）。
    const idx = openIdx;
    const item = result[idx];
    const calls = item.toolCalls;
    const repliedSnapshot = replied;
    openIdx = null;
    replied = new Set();
    if (!calls || calls.length === 0) return;
    const kept = calls.filter((c) => repliedSnapshot.has(c.id));
    if (kept.length === calls.length) return;
    if (kept.length > 0) {
      result[idx] = { ...item, toolCalls: kept };
    } else if (item.content.trim() === '' && !item.reasoningContent) {
      result.splice(idx, 1);
    } else {
      const { toolCalls: _drop, ...rest } = item;
      result[idx] = rest;
    }
  };

  for (const item of output) {
    if (item.role === 'assistant' && item.toolCalls && item.toolCalls.length > 0) {
      // 新组开始：结算上一组（若未闭合则裁剪）
      settle();
      openIdx = result.length;
      replied = new Set();
      result.push(item);
      continue;
    }
    if (item.role === 'tool' && openIdx != null && item.toolCallId) {
      replied.add(item.toolCallId);
    }
    if (item.role === 'user') {
      settle();
    }
    result.push(item);
  }
  settle();
  return result;
}

/**
 * 协议合法性最后防线：确保每条 tool 消息都有前置的 assistant(tool_calls)，
 * 且每个 assistant 的 tool_calls 都被回复。
 * 裁剪（closeToolCallGroups）可能导致 tool 消息失去前置 assistant——
 * 孤立 tool 属于异常数据（正常历史中 tool 必跟在 assistant(tool_calls) 后），
 * 直接移除，不合成新消息（合成的空 content assistant 在 DeepSeek thinking
 * 模式下会触发 "reasoning_content must be passed back" 400）。
 */
function enforceToolProtocol(output: LlmHistoryItem[]): LlmHistoryItem[] {
  const result: LlmHistoryItem[] = [];
  let hasOpenCalls = false;
  for (const item of output) {
    if (item.role === 'assistant' && item.toolCalls && item.toolCalls.length > 0) {
      hasOpenCalls = true;
      result.push(item);
      continue;
    }
    if (item.role === 'tool' && item.toolCallId) {
      if (!hasOpenCalls) {
        // 孤立 tool 消息（无前置 assistant(tool_calls)）：异常数据，直接丢弃
        continue;
      }
      result.push(item);
      continue;
    }
    if (item.role === 'assistant') {
      // 纯 assistant 文本：结束当前 tool 组（tool 消息必须紧跟 assistant(tool_calls)）
      hasOpenCalls = false;
    }
    result.push(item);
  }
  return result;
}

/** 快速切换 SSH tab 时丢弃过期的 sync 结果 */
let syncActiveGeneration = 0;

/** 归档翻页每页条数。与 UI 的展示分页（AgentMessageList PAGE_SIZE）是两个
 *  恰好同值的概念：这里管一次 IPC 取多少条，那边管一次多展示多少条。 */
const EARLIER_PAGE_SIZE = 50;

/** 归档翻页的在飞标记：同一会话滚动连触发时同一锚点只发一次请求。 */
const earlierLoadsInFlight: Set<string> = new Set();

/**
 * **显式**切换对话的代际令牌（历史列表点选 / 任务卡片跳转）。
 *
 * 与 `syncActiveGeneration` 分开：那一枚是「切 tab 触发的同步」，它读的是
 * `activeConversationBySession` 绑定关系 —— 而绑定关系要等显式切换真正落地
 * 才更新，共用一枚令牌会让切 tab 的同步把用户刚点的对话丢掉（同步选出来的
 * 是另一条）。所以：
 * - `switchConversation` 进入时自增、`set` 前校验：慢的那次结果直接作废，
 *   否则先点消息多的 A、再点 B，A 的加载晚归就会把 active 盖回 A；
 *   自增顺带作废在飞的 sync（它算的是切换前的绑定，结论同样过期）；
 * - `loadConversation` 只读不自增（它还是连接恢复流程内部用的加载器），
 *   在校验不过时放弃落地 —— 别盖掉期间发生的显式切换。
 */
let activeSelectionGeneration = 0;

/**
 * 用户中断时卡片追加的说明，按**工具声称的收尾语义**分三套
 * （`toolCatalog.interruptNoticeKind`）。选了哪一套由工具呈现表声明，这里只管
 * 文本 —— 文案是纪律，不允许推导（见下）。
 *
 * ⚠️ 三段与后端 `agent_loop.rs` 的 `interruption_notice` **逐字节一致**：同一件
 * 事，前后端任何路径触发都不能让用户看到两套说辞。改任何一段之前先改后端那
 * 份，再回来同步这里（两边都有断言钉着）。
 *
 * 本机那段必须守住两条（与 `local_bash.rs` 的超时文案同一纪律）：只说「停止
 * 等待、关闭我们这侧的读端」，**绝不能说「已终止进程」**；并指路本机自己的收尾
 * 手段（本机没有 sshd 替用户回收进程）。
 */
const INTERRUPT_NOTICE_SUFFIX: Record<InterruptNoticeKind, string> = {
  'remote-stream':
    '\n\n[用户中断：已停止等待输出并关闭 SSH 通道，但远端进程不保证已终止——只有它之后还往 stdout/stderr 写东西时，才可能因管道断开（SIGPIPE）退出；静默运行、重定向了输出、被 nohup/setsid/& 脱离的命令会继续在服务器上运行。必要时用 ps/pgrep 确认并按需 kill 清理。]',
  local:
    '\n\n[用户中断：已停止等待输出并关闭我们这侧的读端，但本机进程不保证已结束——只有它之后还往 stdout/stderr 写东西时，才可能因管道断开而退出；静默运行、重定向了输出、被 Start-Process / nohup / & 脱离的命令会继续在这台电脑上运行。要收尾就自己查了再结束：Windows 用 `Get-Process` / `tasklist` 找到它、`Stop-Process -Id <pid>` 结束；macOS/Linux 用 `ps` / `pgrep` 找到它、`kill <pid>` 结束。]',
  generic: '\n\n[用户手动中断，已停止等待结果；工具可能已执行完成]',
};

/**
 * 该对话下是否存在正在运行的任务（主 agent 或子 agent）。
 * sessionId 非空排除重启恢复的占位 task。
 *
 * 本机子任务（`local_subagent`）的 sessionId 是哨兵值：**这里要它算真任务** ——
 * 它正在跑，它那条子对话就不该被写入（哨兵值恰恰为此非空）。只有空串（重启
 * 恢复的占位 task）才不算。
 */
export function conversationHasRunningTask(conversationId: string): boolean {
  return Object.values(useTaskStore.getState().tasks).some(
    (t) =>
      t.conversationId === conversationId && !!t.sessionId && isTaskBusy(t.status),
  );
}

/**
 * 该对话是否正在手动压缩上下文（见 `taskStore.compacting`）。
 *
 * 与 `conversationHasRunningTask` 并列存在，只为「提示文案要说清是哪一种忙」；
 * 判断「能不能往这个对话写东西」一律用下面的 `conversationIsBusy`。
 */
export function conversationIsCompacting(conversationId: string): boolean {
  return !!useTaskStore.getState().compacting[conversationId];
}

/**
 * 该对话此刻**能不能被写入** —— 「有运行中的任务」或「正在压缩上下文」。
 *
 * 这是唯一入口：任何「往这个对话写消息 / 改写它的历史」的动作（发送、`/` 命令
 * 菜单、撤回回滚、后台作业自动继续、再压一次）都必须问它，而不是自己挑一个
 * 子条件。手动压缩此前正是漏在这张表之外 —— 它不是任务，于是前端所有 busy
 * 判定都看不见它，压缩期间发出去的消息会被随后落下的压缩卡盖到后面、被归档
 * 边界（最新一张卡之前的行）从后续请求里抹掉。
 *
 * 后端 `agent_start_task` 还有一道同样的兜底守卫（`AppState.compactions`），
 * 但那是防御，不是理由 —— 这里漏了，用户会看到自己的消息被静默吞掉。
 */
export function conversationIsBusy(conversationId: string): boolean {
  return conversationIsCompacting(conversationId) || conversationHasRunningTask(conversationId);
}

/**
 * 切换对话后恢复"当前活动任务"：
 * 该对话有 running task（主 agent / 子 agent）→ 设为 activeTaskId（停止按钮、
 * isRunning 随之恢复）；否则清空。
 *
 * `!!t.sessionId` 排除的是重启恢复的占位 task（空串）；本机子任务的哨兵值算
 * 真任务 —— 切回它的子对话时「停止」按钮要跟着恢复（与
 * `conversationHasRunningTask` 同一口径）。
 */
function restoreRunningTaskForConversation(conversationId: string) {
  const taskStore = useTaskStore.getState();
  taskStore.clearActiveTask();
  const running = Object.values(taskStore.tasks).find(
    (t) =>
      t.conversationId === conversationId && !!t.sessionId && isTaskBusy(t.status),
  );
  if (running) {
    useTaskStore.setState({ activeTaskId: running.id });
  }
}

function reorderByUpdatedAt(convs: Record<string, AgentConversation>): Record<string, AgentConversation> {
  const sorted = Object.values(convs).sort((a, b) => {
    // 置顶优先（与 lib/dateGrouping 的置顶分组同一口径），组内仍按更新时间倒序。
    const pinnedDiff = Number(!!b.pinned) - Number(!!a.pinned);
    if (pinnedDiff !== 0) return pinnedDiff;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
  const reordered: Record<string, AgentConversation> = {};
  for (const c of sorted) reordered[c.id] = c;
  return reordered;
}

export const useConversationStore = create<ConversationState>((set, get) => ({
  conversations: {},
  messages: {},
  hasEarlierMessages: {},
  activeConversationId: null,
  activeConversationByConnection: {},
  activeConversationBySession: {},

  bindConversationToSession: (sessionId: string, conversationId: string, connectionId?: string) => {
    set((state) => {
      const bySession = { ...state.activeConversationBySession, [sessionId]: conversationId };
      const connId = connectionId || state.conversations[conversationId]?.connectionId;
      const byConn = connId
        ? rememberActiveForConnection(state.activeConversationByConnection, connId, conversationId)
        : state.activeConversationByConnection;
      return {
        activeConversationBySession: bySession,
        activeConversationByConnection: byConn,
      };
    });
  },

  unbindSessionConversation: (sessionId: string) => {
    set((state) => {
      if (!state.activeConversationBySession[sessionId]) return state;
      const bySession = { ...state.activeConversationBySession };
      delete bySession[sessionId];
      return { activeConversationBySession: bySession };
    });
  },

  addMessage: (message: AgentMessage) => {
    const convId = get().activeConversationId;
    if (!convId) return;
    set((state) => ({
      messages: {
        ...state.messages,
        [convId]: [...(state.messages[convId] || []), message],
      },
    }));
  },

  clearMessages: () => {
    const convId = get().activeConversationId;
    if (!convId) return;
    set((state) => ({
      messages: { ...state.messages, [convId]: [] },
    }));
  },

  newConversation: async (sessionId: string, connectionId: string) => {
    const id = await tauri.agentCreateConversation(sessionId);
    const now = new Date().toISOString();
    set((state) => ({
      conversations: {
        ...state.conversations,
        [id]: {
          id,
          connectionId,
          title: '新会话',
          createdAt: now,
          updatedAt: now,
        },
      },
      messages: { ...state.messages, [id]: [] },
      activeConversationId: id,
      activeConversationBySession: {
        ...state.activeConversationBySession,
        [sessionId]: id,
      },
      activeConversationByConnection: rememberActiveForConnection(
        state.activeConversationByConnection,
        connectionId,
        id,
      ),
    }));
    await get().loadConnectionConversations(connectionId);
    useTaskStore.getState().clearConversationUnreadCompleted(id);
    return id;
  },

  switchConversation: async (conversationId: string, sessionId?: string) => {
    const myGeneration = ++activeSelectionGeneration;
    // 显式切换 = 最新意图：作废在飞的 sync（它拿的是切换前的绑定，结论已过期）
    syncActiveGeneration++;
    // map 缺失时（如重启后从 task 卡片跳转子对话）补拉元数据，
    // 保证输入区能识别子对话并渲染"返回主对话"条。
    const known = get().conversations[conversationId];
    // 运行中的对话（主 agent / 子 agent 在跑）：跳过 DB 重载，保留内存消息
    // （运行中的 tool 卡片等流式状态尚未落库，重载会导致卡片消失）。
    // 压缩中的对话同理：进行中的压缩卡还没落库，重载会把它从 live store 里冲掉,
    // 用户切走再切回来就看不出这个会话正在压缩了。
    const running = conversationIsBusy(conversationId);
    const [activeRes, storedPlans, meta] = await Promise.all([
      running ? Promise.resolve(null) : tauri.agentLoadActiveMessages(conversationId),
      running ? Promise.resolve(null) : tauri.agentLoadPlansByConversation(conversationId),
      known ? Promise.resolve(null) : tauri.agentGetConversation(conversationId).catch(() => null),
    ]);
    // 期间又点了别的对话（或另一个入口改了 active）：本次结果整份作废
    //（消息缓存也一并丢 —— 宁可下次重载，也不给「慢的那次」留覆盖的机会）。
    // 后面全是同步写，所以这一处校验够用。
    if (activeSelectionGeneration !== myGeneration) return;
    const msgs: AgentMessage[] = running
      ? (get().messages[conversationId] ?? [])
      : clearIntermediateReasoning((activeRes?.messages ?? []).map(storedMessageToAgentMessage));
    set((state) => {
      const connectionId = state.conversations[conversationId]?.connectionId;
      const bySession = sessionId
        ? { ...state.activeConversationBySession, [sessionId]: conversationId }
        : state.activeConversationBySession;
      return {
        conversations: meta ? { ...state.conversations, [meta.id]: meta } : state.conversations,
        messages: { ...state.messages, [conversationId]: msgs },
        hasEarlierMessages: {
          ...state.hasEarlierMessages,
          [conversationId]: activeRes?.hasEarlier ?? false,
        },
        activeConversationId: conversationId,
        activeConversationBySession: bySession,
        activeConversationByConnection: connectionId
          ? rememberActiveForConnection(state.activeConversationByConnection, connectionId, conversationId)
          : state.activeConversationByConnection,
      };
    });
    if (!running) {
      useTaskStore.getState().loadPersistedPlans(conversationId, storedPlans ?? []);
    }
    // 恢复该对话的运行中任务（主 agent / 子 agent），保证停止按钮与 isRunning 状态正确
    restoreRunningTaskForConversation(conversationId);
    // 切入对话后，自动清除该对话的未读完成小绿点标记
    useTaskStore.getState().clearConversationUnreadCompleted(conversationId);
  },

  loadConversation: async (conversationId: string, sessionId?: string) => {
    // 与 switchConversation 共用同一枚令牌，但**只读不自增**：它也是
    // `loadConnectionConversations` 内部用的加载器（连接恢复流程），自增会把
    // 用户刚点的对话丢掉（令牌只留最后一次进入的）。这里要挡的是另一件事：
    // 本次加载期间发生过显式切换 → 结果已过期，别再无条件改 active
    //（`syncActiveToConnection` 的注释里那句「不走 loadConversation，它会无条件
    // 改 active，竞态下会盖掉更新的 tab」说的就是它）。
    const myGeneration = activeSelectionGeneration;
    const known = get().conversations[conversationId];
    // 同 switchConversation：任务在跑或正在压缩都不重载（后者的进行中卡片没落库）
    const running = conversationIsBusy(conversationId);
    const [activeRes, storedPlans, meta] = await Promise.all([
      running ? Promise.resolve(null) : tauri.agentLoadActiveMessages(conversationId),
      running ? Promise.resolve(null) : tauri.agentLoadPlansByConversation(conversationId),
      known ? Promise.resolve(null) : tauri.agentGetConversation(conversationId).catch(() => null),
    ]);
    if (activeSelectionGeneration !== myGeneration) return;
    const msgs: AgentMessage[] = running
      ? (get().messages[conversationId] ?? [])
      : clearIntermediateReasoning((activeRes?.messages ?? []).map(storedMessageToAgentMessage));
    set((state) => {
      const connectionId = state.conversations[conversationId]?.connectionId;
      const bySession = sessionId
        ? { ...state.activeConversationBySession, [sessionId]: conversationId }
        : state.activeConversationBySession;
      return {
        conversations: meta ? { ...state.conversations, [meta.id]: meta } : state.conversations,
        messages: { ...state.messages, [conversationId]: msgs },
        hasEarlierMessages: {
          ...state.hasEarlierMessages,
          [conversationId]: activeRes?.hasEarlier ?? false,
        },
        activeConversationId: conversationId,
        activeConversationBySession: bySession,
        activeConversationByConnection: connectionId
          ? rememberActiveForConnection(state.activeConversationByConnection, connectionId, conversationId)
          : state.activeConversationByConnection,
      };
    });
    if (!running) {
      useTaskStore.getState().loadPersistedPlans(conversationId, storedPlans ?? []);
    }
    restoreRunningTaskForConversation(conversationId);
    useTaskStore.getState().clearConversationUnreadCompleted(conversationId);
  },

  loadEarlierHistory: async (conversationId: string) => {
    const current = get().messages[conversationId] || [];
    if (current.length === 0) return;
    // 在飞防抖：滚动连触发时同一锚点只发一次请求，避免并发拉出重复页
    if (earlierLoadsInFlight.has(conversationId)) return;
    earlierLoadsInFlight.add(conversationId);
    const oldestMessageId = current[0].id;

    try {
      const { messages: earlierStored, hasMore } = await tauri.agentLoadEarlierMessages(
        conversationId,
        oldestMessageId,
        EARLIER_PAGE_SIZE,
      );
      if (earlierStored.length === 0) {
        set((state) => ({
          hasEarlierMessages: { ...state.hasEarlierMessages, [conversationId]: false },
        }));
        return;
      }
      const earlierMsgs = clearIntermediateReasoning(earlierStored.map(storedMessageToAgentMessage));
      set((state) => {
        const existing = state.messages[conversationId] || [];
        return {
          messages: {
            ...state.messages,
            [conversationId]: [...earlierMsgs, ...existing],
          },
          hasEarlierMessages: {
            ...state.hasEarlierMessages,
            // 后端说还有就还有；翻页契约不再「一次补齐」
            [conversationId]: hasMore,
          },
        };
      });
    } catch (err) {
      console.error('[conversationStore] loadEarlierHistory failed:', err);
    } finally {
      earlierLoadsInFlight.delete(conversationId);
    }
  },

  renameConversation: async (conversationId: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    await tauri.agentRenameConversation(conversationId, trimmed);
    const now = new Date().toISOString();
    set((state) => {
      const conv = state.conversations[conversationId];
      if (!conv) return state;
      const updated = { ...conv, title: trimmed, updatedAt: now };
      return {
        conversations: reorderByUpdatedAt({
          ...state.conversations,
          [conversationId]: updated,
        }),
      };
    });
  },

  /**
   * 置顶/取消置顶会话。与 `renameConversation` 同一模式：**先 await 后端成功，
   * 再改本地**（后端才是权威，失败就不动本地，避免 UI 与磁盘不一致）。
   */
  setConversationPinned: async (conversationId: string, pinned: boolean) => {
    await tauri.agentSetConversationPinned(conversationId, pinned);
    set((state) => {
      const conv = state.conversations[conversationId];
      if (!conv) return state;
      return {
        conversations: reorderByUpdatedAt({
          ...state.conversations,
          [conversationId]: { ...conv, pinned },
        }),
      };
    });
  },

  setConversationModel: async (conversationId: string, modelId: string | null) => {
    // 1) 写后端内存会话记忆（不落盘；后端路由据此 + list/get 会 overlay 回读）
    await tauri.agentSetSessionModel(conversationId, modelId);
    // 2) 本地 conv.modelId 同步（UI 读取点；load 时后端 overlay 也会带回来）
    //    切模型后显示**新模型自己**记的思考档位：读后端 (会话, 新模型)
    //    记忆并同步到 conv.reasoningEffort，避免残留旧模型的档位显示。
    const effModelId = effectiveModelId(
      useSettingsStore.getState().settings.llmRegistry,
      modelId,
    );
    const effort = effModelId
      ? await tauri.agentGetSessionEffort(conversationId, effModelId).catch(() => null)
      : null;
    set((state) => {
      const conv = state.conversations[conversationId];
      if (!conv) return state;
      return {
        conversations: {
          ...state.conversations,
          [conversationId]: {
            ...conv,
            modelId: modelId ?? null,
            reasoningEffort: effort,
          },
        },
      };
    });
    // 3) 用户在某会话切换模型 = 顺带成为全局最近使用（实时落盘 + 参与 sync）。
    //    复用 settingsStore.update 完整保存链路（校验/持久化/字段级同步）。
    //    仅当切到具体模型时更新；清除记忆(null)不改变全局最近使用。
    if (modelId) {
      const settingsStore = useSettingsStore.getState();
      const reg = settingsStore.settings.llmRegistry;
      if (reg && reg.lastUsedModelId !== modelId) {
        settingsStore
          .update({ llmRegistry: { ...reg, lastUsedModelId: modelId } })
          .catch((err) => {
            console.error('[conversationStore] persist lastUsedModelId failed', err);
          });
      }
    }
  },

  setConversationEffort: async (conversationId: string, reasoningEffort: string | null) => {
    // 档位归属当前生效模型（会话记忆 → 全局最近使用 → 首个），按
    // 「会话 × 模型」双维写入后端（内存 + efforts_json 落盘，重启记住；
    // 任务启动时据此注入）
    const effModelId = effectiveModelId(
      useSettingsStore.getState().settings.llmRegistry,
      get().conversations[conversationId]?.modelId,
    );
    if (!effModelId) return; // 无模型可归属：不记录（UI 无模型时也不会显示选择器）
    await tauri.agentSetSessionEffort(conversationId, effModelId, reasoningEffort);
    // 本地 conv.reasoningEffort 同步（UI 读取点；load 时后端 overlay 也会带回来）
    set((state) => {
      const conv = state.conversations[conversationId];
      if (!conv) return state;
      // 保存期间可能切换了模型；旧模型的持久化结果不能覆盖新模型的显示档位。
      const currentModelId = effectiveModelId(
        useSettingsStore.getState().settings.llmRegistry,
        conv.modelId,
      );
      if (currentModelId !== effModelId) return state;
      return {
        conversations: {
          ...state.conversations,
          [conversationId]: { ...conv, reasoningEffort: reasoningEffort ?? null },
        },
      };
    });
  },

  deleteConversation: async (conversationId: string) => {
    await tauri.agentDeleteConversation(conversationId);
    // 级联：主对话 + 其全部子agent对话（后端已级联删 DB）。
    // 在 set 之前从当前 map 快照收集（set 后子对话条目已不存在）。
    const ids = [
      conversationId,
      ...Object.values(get().conversations)
        .filter((c) => c.parentConversationId === conversationId)
        .map((c) => c.id),
    ];
    set((state) => {
      const conversations = { ...state.conversations };
      const messages = { ...state.messages };
      const byConnection = { ...state.activeConversationByConnection };
      const bySession = { ...state.activeConversationBySession };

      for (const [sid, cid] of Object.entries(bySession)) {
        if (ids.includes(cid)) {
          delete bySession[sid];
        }
      }

      for (const id of ids) {
        const removed = conversations[id];
        delete conversations[id];
        delete messages[id];
        if (removed && byConnection[removed.connectionId] === id) {
          delete byConnection[removed.connectionId];
        }
      }
      let nextActive = state.activeConversationId;
      if (state.activeConversationId != null && ids.includes(state.activeConversationId)) {
        const removed = state.conversations[conversationId];
        nextActive = removed
          ? pickPreferredConversationId(conversations, removed.connectionId, byConnection[removed.connectionId])
          : Object.keys(conversations)[0] || null;
        if (nextActive && removed) {
          byConnection[removed.connectionId] = nextActive;
        }
      }
      return {
        conversations,
        messages,
        activeConversationId: nextActive,
        activeConversationBySession: bySession,
        activeConversationByConnection: byConnection,
      };
    });
    // 级联清理 taskStore 中这些 conversation 的 plans 和 tasks
    for (const id of ids) {
      useTaskStore.getState().clearPlansByConversation(id);
      useTurnFoldStore.getState().clearConversation(id);
    }
  },

  rollbackToMessage: async (conversationId: string, messageId: string) => {
    let msgs = get().messages[conversationId] || [];
    let index = msgs.findIndex((m) => m.id === messageId);
    // 目标不在当前活跃切片中：逐页补齐更早历史再寻找（归档现在是真分页，
    // 一次补页未必能覆盖目标所在位置）
    while (index < 0 && get().hasEarlierMessages[conversationId]) {
      await get().loadEarlierHistory(conversationId);
      msgs = get().messages[conversationId] || [];
      index = msgs.findIndex((m) => m.id === messageId);
    }
    if (index < 0) {
      throw new Error('消息不存在');
    }

    const target = msgs[index];
    if (target.role !== 'user') {
      throw new Error('只能撤回用户消息');
    }

    const removedCount = msgs.length - index;
    const truncateResult = await tauri.agentTruncateConversation(
      conversationId,
      target.timestamp,
    );

    set((state) => ({
      messages: {
        ...state.messages,
        [conversationId]: (state.messages[conversationId] || []).slice(0, index),
      },
    }));

    // 仅当后端按快照调整过 plan 时同步 UI；旧数据无快照则不动 plan
    if (truncateResult.planAdjusted) {
      useTaskStore.getState().applyPlanAfterTruncate(
        conversationId,
        truncateResult.plan ?? null,
        truncateResult.planTaskId ?? null,
      );
    }

    return {
      prompt: target.content,
      removedCount: truncateResult.deletedMessages || removedCount,
      imagePaths: target.imagePaths ?? [],
    };
  },

  clearConnectionConversations: (connectionId: string) => {
    const convs = get().conversations;
    const toRemove = Object.values(convs)
      .filter((c) => c.connectionId === connectionId)
      .map((c) => c.id);
    set((state) => {
      const conversations = { ...state.conversations };
      const messages = { ...state.messages };
      for (const id of toRemove) {
        delete conversations[id];
        delete messages[id];
      }
      const byConnection = { ...state.activeConversationByConnection };
      delete byConnection[connectionId];
      return {
        conversations,
        messages,
        activeConversationId:
          state.activeConversationId && toRemove.includes(state.activeConversationId)
            ? Object.keys(conversations)[0] || null
            : state.activeConversationId,
        activeConversationByConnection: byConnection,
      };
    });
  },

  loadConnectionConversations: async (connectionId: string) => {
    const convs = await tauri.agentListConversationsByConnection(connectionId);
    let activeConversationId: string | null = null;

    set((state) => {
      const incomingConvIds = new Set(convs.map((c) => c.id));

      const toRemove = Object.values(state.conversations)
        .filter(
          (c) =>
            c.connectionId === connectionId &&
            !incomingConvIds.has(c.id) &&
            // 子agent对话被后端列表接口过滤（不在 incoming 中），不是多余项
            !c.parentConversationId,
        )
        .map((c) => c.id);

      const newConversations: Record<string, AgentConversation> = { ...state.conversations };
      const newMessages: Record<string, AgentMessage[]> = { ...state.messages };
      const byConnection = { ...state.activeConversationByConnection };

      for (const id of toRemove) {
        delete newConversations[id];
        delete newMessages[id];
        if (byConnection[connectionId] === id) {
          delete byConnection[connectionId];
        }
      }

      for (const conv of convs) {
        newConversations[conv.id] = conv;
        newMessages[conv.id] = state.messages[conv.id] ?? [];
      }

      // 仅当「当前 active 属于本 connection」时保留；跨 connection 的 active 不抢（由 syncActiveToConnection 切换）
      const currentActive = state.activeConversationId;
      const activeBelongsHere =
        !!currentActive && newConversations[currentActive]?.connectionId === connectionId;
      const preferred = pickPreferredConversationId(
        newConversations,
        connectionId,
        byConnection[connectionId],
      );
      const firstConvId = convs.length > 0 ? convs[0].id : null;

      if (!currentActive || activeBelongsHere) {
        activeConversationId = activeBelongsHere
          ? currentActive!
          : preferred || firstConvId || null;
        if (activeConversationId) {
          byConnection[connectionId] = activeConversationId;
        }
      } else {
        // 当前 UI 在别的 connection 上：只合并本 connection 的列表
        activeConversationId = currentActive;
        if (preferred) {
          byConnection[connectionId] = preferred;
        } else if (firstConvId) {
          byConnection[connectionId] = firstConvId;
        }
      }

      return {
        conversations: reorderByUpdatedAt(newConversations),
        messages: newMessages,
        activeConversationId,
        activeConversationByConnection: byConnection,
      };
    });

    if (activeConversationId && !get().messages[activeConversationId]?.length) {
      const activeConv = get().conversations[activeConversationId];
      if (activeConv?.connectionId === connectionId) {
        await get().loadConversation(activeConversationId);
      }
    }
  },

  syncActiveToSession: async (sessionId: string, connectionId: string) => {
    const myGeneration = ++syncActiveGeneration;
    const stillTarget = () => syncActiveGeneration === myGeneration;

    const restoreActiveTaskForConversation = (conversationId: string) => {
      if (!stillTarget()) return;
      restoreRunningTaskForConversation(conversationId);
    };

    const applyActive = (conversationId: string, msgs?: AgentMessage[], hasEarlier?: boolean) => {
      if (!stillTarget()) return false;
      set((s) => ({
        ...(msgs
          ? { messages: { ...s.messages, [conversationId]: msgs } }
          : {}),
        ...(hasEarlier === undefined
          ? {}
          : { hasEarlierMessages: { ...s.hasEarlierMessages, [conversationId]: hasEarlier } }),
        activeConversationId: conversationId,
        activeConversationBySession: {
          ...s.activeConversationBySession,
          [sessionId]: conversationId,
        },
        activeConversationByConnection: rememberActiveForConnection(
          s.activeConversationByConnection,
          connectionId,
          conversationId,
        ),
      }));
      return stillTarget();
    };

    const state = get();
    const boundConvId = state.activeConversationBySession[sessionId];

    if (boundConvId && state.conversations[boundConvId]) {
      // 本 session 已有绑定的对话
      if (state.activeConversationId === boundConvId) {
        restoreActiveTaskForConversation(boundConvId);
        return;
      }
      const cached = state.messages[boundConvId];
      if (cached?.length) {
        if (!applyActive(boundConvId)) return;
        restoreActiveTaskForConversation(boundConvId);
        return;
      }
      // 活跃窗口加载（与 switchConversation 同源）：LLM 上下文本就只取最新
      // 压缩卡之后的内容，归档按页翻；冷路径不再隐式全量拉归档。
      const [activeRes, storedPlans] = await Promise.all([
        tauri.agentLoadActiveMessages(boundConvId),
        tauri.agentLoadPlansByConversation(boundConvId),
      ]);
      if (!stillTarget()) return;
      const msgs: AgentMessage[] = clearIntermediateReasoning(activeRes.messages.map(storedMessageToAgentMessage));
      if (!applyActive(boundConvId, msgs, activeRes.hasEarlier)) return;
      useTaskStore.getState().loadPersistedPlans(boundConvId, storedPlans);
      restoreActiveTaskForConversation(boundConvId);
      return;
    }

    // 若无明确 session 绑定，加载 connection 对话并回退到未被占用的 preferred 或新建
    await get().loadConnectionConversations(connectionId);
    if (!stillTarget()) return;

    const afterLoad = get();
    const preferred = pickPreferredConversationId(
      afterLoad.conversations,
      connectionId,
      afterLoad.activeConversationByConnection[connectionId],
    );

    if (!preferred) {
      if (afterLoad.activeConversationId && stillTarget()) {
        const stillOther =
          afterLoad.conversations[afterLoad.activeConversationId]?.connectionId !== connectionId;
        if (stillOther) {
          set({ activeConversationId: null });
          useTaskStore.getState().clearActiveTask();
        }
      }
      return;
    }

    const cached = afterLoad.messages[preferred];
    if (cached?.length) {
      if (!applyActive(preferred)) return;
      restoreActiveTaskForConversation(preferred);
      return;
    }

    const [activeRes, storedPlans] = await Promise.all([
      tauri.agentLoadActiveMessages(preferred),
      tauri.agentLoadPlansByConversation(preferred),
    ]);
    if (!stillTarget()) return;
    const msgs: AgentMessage[] = clearIntermediateReasoning(activeRes.messages.map(storedMessageToAgentMessage));
    if (!applyActive(preferred, msgs, activeRes.hasEarlier)) return;
    useTaskStore.getState().loadPersistedPlans(preferred, storedPlans);
    restoreActiveTaskForConversation(preferred);
  },

  syncActiveToConnection: async (connectionId: string, sessionId?: string) => {
    if (sessionId) {
      return get().syncActiveToSession(sessionId, connectionId);
    }
    const myGeneration = ++syncActiveGeneration;
    const stillTarget = () => syncActiveGeneration === myGeneration;

    const restoreActiveTaskForConversation = (conversationId: string) => {
      if (!stillTarget()) return;
      restoreRunningTaskForConversation(conversationId);
    };

    const applyActive = (conversationId: string, msgs?: AgentMessage[], hasEarlier?: boolean) => {
      if (!stillTarget()) return false;
      set((s) => ({
        ...(msgs
          ? { messages: { ...s.messages, [conversationId]: msgs } }
          : {}),
        ...(hasEarlier === undefined
          ? {}
          : { hasEarlierMessages: { ...s.hasEarlierMessages, [conversationId]: hasEarlier } }),
        activeConversationId: conversationId,
        activeConversationByConnection: rememberActiveForConnection(
          s.activeConversationByConnection,
          connectionId,
          conversationId,
        ),
      }));
      return stillTarget();
    };

    const state = get();
    const current = state.activeConversationId
      ? state.conversations[state.activeConversationId]
      : null;
    if (current?.connectionId === connectionId) {
      if (state.activeConversationId && stillTarget()) {
        set({
          activeConversationByConnection: rememberActiveForConnection(
            state.activeConversationByConnection,
            connectionId,
            state.activeConversationId,
          ),
        });
      }
      return;
    }

    await get().loadConnectionConversations(connectionId);
    if (!stillTarget()) return;

    const afterLoad = get();
    const preferred = pickPreferredConversationId(
      afterLoad.conversations,
      connectionId,
      afterLoad.activeConversationByConnection[connectionId],
    );

    if (!preferred) {
      // 该 connection 无对话：清空 active，避免仍显示其它主机的聊天
      if (afterLoad.activeConversationId && stillTarget()) {
        const stillOther =
          afterLoad.conversations[afterLoad.activeConversationId]?.connectionId !== connectionId;
        if (stillOther) {
          set({ activeConversationId: null });
          useTaskStore.getState().clearActiveTask();
        }
      }
      return;
    }

    const cached = afterLoad.messages[preferred];
    if (cached?.length) {
      if (!applyActive(preferred)) return;
      restoreActiveTaskForConversation(preferred);
      return;
    }

    // 不走 loadConversation：它会无条件改 active，竞态下会盖掉更新的 tab。
    // 活跃窗口加载（同 syncActiveToSession）：冷路径不再隐式全量拉归档。
    const [activeRes, storedPlans] = await Promise.all([
      tauri.agentLoadActiveMessages(preferred),
      tauri.agentLoadPlansByConversation(preferred),
    ]);
    if (!stillTarget()) return;
    const msgs: AgentMessage[] = clearIntermediateReasoning(activeRes.messages.map(storedMessageToAgentMessage));
    if (!applyActive(preferred, msgs, activeRes.hasEarlier)) return;
    useTaskStore.getState().loadPersistedPlans(preferred, storedPlans);
    restoreActiveTaskForConversation(preferred);
  },

  getCurrentMessages: () => {
    const convId = get().activeConversationId;
    if (!convId) return [];
    return get().messages[convId] || [];
  },

  ensureConversation: async (sessionId: string, connectionId: string, fallbackTitle: string) => {
    const { activeConversationId, conversations } = get();
    const activeConv = activeConversationId ? conversations[activeConversationId] : null;
    const activeMatches =
      !!activeConversationId &&
      !!activeConv &&
      (!connectionId || activeConv.connectionId === connectionId);

    let conversationId: string;

    if (!activeMatches) {
      // 优先检查本 session 已有记忆
      const boundId = get().activeConversationBySession[sessionId];
      const preferred = (boundId && conversations[boundId] && !conversations[boundId].parentConversationId)
        ? boundId
        : (connectionId
            ? pickPreferredConversationId(
                conversations,
                connectionId,
                get().activeConversationByConnection[connectionId],
              )
            : null);

      if (preferred) {
        conversationId = preferred;
        set((state) => ({
          activeConversationId: preferred,
          activeConversationBySession: {
            ...state.activeConversationBySession,
            [sessionId]: preferred,
          },
          activeConversationByConnection: connectionId
            ? rememberActiveForConnection(state.activeConversationByConnection, connectionId, preferred)
            : state.activeConversationByConnection,
        }));
        // 复用已有对话时若本地无消息，先从 DB 拉齐活跃段（LLM 历史只取
        // 最新压缩卡之后的内容，这里拉齐窗口即可，归档交给翻页），避免
        // LLM 历史为空
        if (!get().messages[preferred]?.length) {
          const activeRes = await tauri.agentLoadActiveMessages(preferred);
          if (get().activeConversationId === preferred) {
            const msgs = clearIntermediateReasoning(activeRes.messages.map(storedMessageToAgentMessage));
            set((state) => ({
              messages: { ...state.messages, [preferred]: msgs },
              hasEarlierMessages: {
                ...state.hasEarlierMessages,
                [preferred]: activeRes.hasEarlier,
              },
            }));
          }
        }
      } else {
        const newTitle = fallbackTitle.slice(0, 30);
        const newId = await tauri.agentCreateConversation(sessionId, newTitle);
        conversationId = newId;
        set((state) => ({
          conversations: reorderByUpdatedAt({
            ...state.conversations,
            [newId]: {
              id: newId,
              connectionId,
              title: newTitle,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          }),
          messages: { ...state.messages, [newId]: [] },
          activeConversationId: newId,
          activeConversationBySession: {
            ...state.activeConversationBySession,
            [sessionId]: newId,
          },
          activeConversationByConnection: connectionId
            ? rememberActiveForConnection(state.activeConversationByConnection, connectionId, newId)
            : state.activeConversationByConnection,
        }));
      }
    } else {
      conversationId = activeConversationId!;
      set((state) => ({
        activeConversationBySession: {
          ...state.activeConversationBySession,
          [sessionId]: conversationId,
        },
      }));
      const conv = get().conversations[conversationId];
      if (conv && conv.title === '新会话') {
        const newTitle = fallbackTitle.slice(0, 30);
        set((state) => ({
          conversations: {
            ...state.conversations,
            [conversationId]: { ...conv, title: newTitle },
          },
        }));
      }
    }

    return conversationId;
  },

  appendMessages: (conversationId: string, messages: AgentMessage[]) => {
    const now = new Date().toISOString();
    set((state) => {
      const conv = state.conversations[conversationId];
      const nextConvs = conv
        ? reorderByUpdatedAt({
            ...state.conversations,
            [conversationId]: { ...conv, updatedAt: now },
          })
        : state.conversations;
      return {
        conversations: nextConvs,
        messages: {
          ...state.messages,
          [conversationId]: [...(state.messages[conversationId] || []), ...messages],
        },
      };
    });
  },

  updateConversationMessages: (conversationId: string, updater: (messages: AgentMessage[]) => AgentMessage[]) => {
    set((state) => ({
      messages: {
        ...state.messages,
        [conversationId]: updater(state.messages[conversationId] || []),
      },
    }));
  },

  compactConversation: async (conversationId: string) => {
    // busy 守卫（与后端一致）：有任务在跑、或已经在压缩 → 拒绝（'/' 菜单同样
    // 不唤出）。守卫在 listener 建立之前，事件路径不可达 → 直接给可见提示再拒绝。
    // 分两种文案：用户要能分清「等任务」还是「等这次压缩」。
    if (conversationIsBusy(conversationId)) {
      const err = new Error(
        conversationIsCompacting(conversationId)
          ? '该会话正在压缩上下文，请等待完成或取消后再试'
          : '会话正在运行任务，请等待任务结束或停止后再压缩',
      );
      get().updateConversationMessages(conversationId, (msgs) => [
        ...msgs,
        {
          id: crypto.randomUUID(),
          role: 'system',
          content: getErrorMessage(err),
          timestamp: new Date().toISOString(),
        },
      ]);
      throw err;
    }
    // 占位：从这里开始到 `finally` 解锁为止，本会话对外表现为「忙」——
    // 发送、`/` 菜单、撤回、后台作业自动继续全部让路。
    //
    // 快照必须先于上锁，且两者之间**没有任何 await**（都是同步代码，别的写入
    // 插不进来）：先上锁再算快照的话，`buildLlmHistory` 万一抛错锁就泄留了。
    // 压缩的卡片按「提交那一刻的队尾」落位（后端 `persist_compaction`、前端
    // `applyCompactionSplice` 的 manual 分支），从这份快照到提交之间隔着一次完整
    // 的摘要调用——这期间写进来的消息会被卡片盖到后面，再被归档边界（最新一张卡
    // 之前的行）从后续请求里抹掉，占位就是为了让这个窗口一次都不出现。
    const taskId = crypto.randomUUID();
    // 压缩对象 = buildLlmHistory 产物（与 agent_start_task 同源，tool 协议
    // 已闭合修正，避免中断遗留的未闭合 tool 调用组导致无法压缩）
    const history = get().buildLlmHistory(conversationId);
    useTaskStore.getState().beginCompaction(conversationId);
    try {
      // 完整复用现有 stream 监听：后端把压缩事件实时转发到
      // `agent://stream/{taskId}`，经 attachStreamListener 分发到
      // handleCompactionStart/Progress/Done/Skipped —— 进行中卡片、原位替换、
      // attempted 区分、进度实时文本全在其中。
      await attachStreamListener(taskId, conversationId, '');
      const result = await tauri.agentCompactConversation(conversationId, history, taskId);
      // live store 的原位插入由 Done 事件路径（handleCompactionDone）负责；
      // 结果路径不再操作 store——原文全保留，事件丢失时缺的只是卡片标记
      // （DB 已由后端落库，重载可见），无副作用风险。
      if (result.compacted) {
        // 压缩已由后端持久化；前端 live 视图靠事件更新。
      } else {
        // compacted:false 兜底：Skipped 事件可能已处理或已丢失，按残留状态收尾
        const state = getStreamState(taskId);
        const cardId = state.compactionMessageId;
        if (cardId) {
          // 残留 running 卡 = Skipped 事件丢失：结果路径兜底，
          // 语义与 handleCompactionSkipped 一致（attempted → 转文本；否则移除）。
          state.compactionMessageId = null;
          setStreamState(taskId, state);
          get().updateConversationMessages(conversationId, (msgs) => {
            const idx = msgs.findIndex((m) => m.id === cardId);
            if (idx === -1) return msgs;
            const newMsgs = [...msgs];
            if (result.attempted) {
              newMsgs[idx] = {
                ...newMsgs[idx],
                content: `上下文压缩未完成：${result.reason ?? '压缩未完成'}`,
                compaction: undefined,
              };
            } else {
              newMsgs.splice(idx, 1);
            }
            return newMsgs;
          });
        } else if (!result.attempted) {
          // 无可压区间 / 区间过小（attempted=false）：事件路径刻意不留痕，
          // 结果路径给手动场景可见提示（普通 system 通知，不落库）。
          get().updateConversationMessages(conversationId, (msgs) => [
            ...msgs,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content: `无需压缩：${result.reason ?? '没有可压缩的早期历史区间'}`,
              timestamp: new Date().toISOString(),
            },
          ]);
        }
        // attempted=true 且无残留卡 = 事件已正常处理（卡已转"未完成"文本）→ 不重复插入
      }
      return result;
    } catch (err) {
      // 命令失败（未配置 LLM / 任务运行中 等）：进行中卡片转错误文本（若有）；
      // 无卡时插入普通 system 失败提示，避免静默无反馈。
      const cardId = getStreamState(taskId).compactionMessageId;
      if (cardId) {
        get().updateConversationMessages(conversationId, (msgs) =>
          msgs.map((m) =>
            m.id === cardId ? { ...m, content: `上下文压缩失败：${getErrorMessage(err)}` } : m,
          ),
        );
      } else {
        get().updateConversationMessages(conversationId, (msgs) => [
          ...msgs,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `上下文压缩失败：${getErrorMessage(err)}`,
            timestamp: new Date().toISOString(),
          },
        ]);
      }
      throw err;
    } finally {
      cleanupTaskListeners(taskId);
      // 解锁（成功 / 跳过 / 失败 / 被取消都要走到）。漏掉它 = 该会话输入框
      // 永久禁用：发送、`/` 菜单、撤回全被 `conversationIsBusy` 拦住。
      useTaskStore.getState().endCompaction(conversationId);
    }
  },

  cancelCompaction: async (conversationId: string) => {
    return tauri.agentCancelCompaction(conversationId);
  },

  registerSubConversation: (conversationId, connectionId, title, subTaskId, prompt, parentConversationId) => {
    const now = new Date().toISOString();
    const loadingId = `sub-loading-${subTaskId}`;
    let result: string | null = loadingId;
    set((state) => {
      // 幂等：已注册过（可能由 toolResult 兜底路径先注册）则不再覆盖骨架，
      // 避免把已有实时流式消息冲掉。
      if (state.conversations[conversationId]) {
        result = null;
        return state;
      }
      return {
        conversations: {
          ...state.conversations,
          [conversationId]: {
            id: conversationId,
            connectionId,
            title,
            createdAt: now,
            updatedAt: now,
            parentConversationId,
          },
        },
        messages: {
          ...state.messages,
          [conversationId]: [
            {
              id: `sub-user-${subTaskId}`,
              role: 'user',
              content: prompt,
              timestamp: now,
            },
            {
              id: loadingId,
              role: 'assistant',
              content: '',
              timestamp: now,
              isLoading: true,
            },
          ],
        },
      };
    });
    return result;
  },

  clearAllAssistantFlags: (conversationId?: string) => {
    set((state) => ({
      messages: Object.fromEntries(
        Object.entries(state.messages).map(([convId, msgs]) => [
          convId,
          !conversationId || convId === conversationId
            ? msgs.map((m) =>
                m.role === 'assistant' && (m.isThinking || m.isLoading)
                  ? { ...m, isThinking: false, isLoading: false }
                  : m,
              )
            : msgs,
        ]),
      ),
    }));
  },

  clearExecutingToolFlags: () => {
    set((state) => ({
      messages: Object.fromEntries(
        Object.entries(state.messages).map(([convId, msgs]) => [
          convId,
          msgs.map((m) =>
            m.role === 'tool' && (m.isExecuting || m.modelApproval) ? { ...m, isExecuting: false, modelApproval: undefined } : m,
          ),
        ]),
      ),
    }));
  },

  markAbortedToolFlags: (conversationId?: string) => {
    // 用户点停止时调用。把所有正在执行的 tool 卡片标记为「已中断」：
    // - isExecuting=false, modelApproval 清除
    // - wasAborted=true
    // - 文案按**工具声称的收尾语义**挑（`interruptNoticeKind`，不是「流式与否」）：
    //   远端流式命令（bash）说「已停止等待输出并关闭 SSH 通道…」；本机命令
    //   （local_bash）说「已停止等待本机命令…本机进程不保证已结束…」；其余说
    //   「工具可能已执行完成」。
    // 文案与后端 agent_loop 检查点4 的中断保持逐字节一致（同一份语义，
    // 前后端任何路径触发都不能让用户看到两套说辞）。⚠️ 本机那套文案后端目前
    // **还没有**（`agent_loop.rs` 的收尾分支只认 `bash`，local_bash 会落到
    // 「工具可能已执行完成」）—— 后端补上同一段字节前，前端这条是本机视角的
    // 唯一正确说法，后端那条要跟着改。
    // 注意：非流式工具后端有完整 output 但前端不可能收到（listener 已卸载），
    // 这里只反映用户视角的 UI 状态；LLM 历史由后端持久化保证完整。
    // conversationId 参数：子agent存在后，停止某个任务只标记该任务所属对话的
    // 卡片，避免误伤其他对话（主/子对话）并行执行中的工具卡片。
    set((state) => ({
      messages: Object.fromEntries(
        Object.entries(state.messages).map(([convId, msgs]) => [
          convId,
          !conversationId || convId === conversationId
            ? msgs.map((m) => {
                if (m.role !== 'tool' || !(m.isExecuting || m.modelApproval)) return m;
                const suffix =
                  INTERRUPT_NOTICE_SUFFIX[interruptNoticeKind(m.toolResult?.toolName ?? '')];
                const existing = m.toolResult?.result ?? '';
                // 已有流式输出时追加，否则整体替换为提示
                const result = existing ? existing + suffix : suffix.trimStart();
                return {
                  ...m,
                  isExecuting: false,
                  modelApproval: undefined,
                  toolResult: m.toolResult
                    ? { ...m.toolResult, wasAborted: true, success: false, result }
                    : m.toolResult,
                };
              })
            : msgs,
        ]),
      ),
    }));
  },

  markTailTurnState: (conversationId: string, state: TurnState) => {
    // 回合收尾状态的内存镜像：写到该对话**尾回合的锚点**（最后一条 user
    // 消息）上 —— 后端持久化的是同一行同一字段（`messages.turn_state`），
    // 重载后由 load 路径填回，两边落点一致。判定规则见 `agentTurnFold`：
    // 只有 completed 允许把过程折叠起来。
    //
    // 为何要在这里写而不是等后端事件：手动停止时前端已按设计拆掉该任务的
    // 流通道（避免晚到的 Done 被当成「已完成」），事件不可能到达。
    set((store) => {
      const msgs = store.messages[conversationId];
      if (!msgs) return store;
      const next = withTailTurnState(msgs, state);
      if (next === msgs) return store;
      return {
        messages: { ...store.messages, [conversationId]: next },
      };
    });
  },

  buildLlmHistory: (conversationId: string) => {
    const msgs = get().messages[conversationId] || [];

    const output: ReturnType<ConversationState['buildLlmHistory']> = [];
    let pendingAssistantIndex: number | null = null;
    /** 为 true 时，后续连续 tool 消息追加到同一条 assistant 的 toolCalls */
    let openToolGroup = false;
    let prevOutputRole: string | null = null;

    // 请求侧屏蔽：最后一张 done 卡（被压区间末尾的边界标记）之前的所有内容
    // 不进 LLM 请求（原文仍全部可见，仅请求屏蔽）。卡片由 live splice /
    // 持久化 created_at 定位在 span 末尾 → "卡前"恰为被压区间（手动压到最末时
    // 卡在对话末尾 → 全部屏蔽 → 请求只剩 checkpoint）。旧卡已被吸收，恒单卡。
    let lastCardIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'system' && msgs[i].compaction?.status === 'done') {
        lastCardIdx = i;
        break;
      }
    }

    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.isLoading) continue;
      if (i < lastCardIdx) continue; // 屏蔽卡前内容（被压区间 + 通知）

      if (m.role === 'system') {
        // 压缩 done 卡 → user 角色 checkpoint（framing 与后端逐字节一致，
        // 二次压缩的 PRIOR checkpoint 识别依赖它），让模型把压缩历史当作
        // 既有背景；其余 system（通知/运行中卡）照旧跳过。
        const checkpoint = compactionCheckpoint(m);
        if (checkpoint) {
          output.push(checkpoint);
          pendingAssistantIndex = null;
          openToolGroup = false;
          prevOutputRole = 'user';
        }
        continue;
      }

      if (m.role === 'user' || m.role === 'notice') {
        // `notice` = 系统替后台作业写的结算告知（自动继续那一轮的 prompt）。
        // 对模型而言它就是一条 user 消息 —— 与 DSH 把插件告知当 user 消息交给
        // 模型同一语义（那边靠 message source 区分，这边靠落库 role）。
        const item: ReturnType<ConversationState['buildLlmHistory']>[number] = {
          role: 'user',
          content: m.content,
          ...(m.dbId ? { dbId: m.dbId } : {}),
        };
        if (m.imagePaths && m.imagePaths.length > 0) {
          item.imagePaths = m.imagePaths;
        }
        output.push(item);
        pendingAssistantIndex = null;
        openToolGroup = false;
        prevOutputRole = 'user';
        continue;
      }

      if (m.role === 'assistant') {
        const fullCalls =
          m.toolCalls && m.toolCalls.length > 0
            ? m.toolCalls
            : m.toolCall
              ? [m.toolCall]
              : null;

        if (fullCalls) {
          const item: ReturnType<ConversationState['buildLlmHistory']>[number] = {
            role: 'assistant',
            content: m.content,
            toolCalls: fullCalls.map((tc) => ({
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments || {},
            })),
            ...(m.dbId ? { dbId: m.dbId } : {}),
          };
          // DeepSeek thinking 模式：带 tool_calls 的 assistant 必须回传
          // reasoning_content（落库已保留，重载后这里原样带上）
          if (m.reasoningContent) {
            item.reasoningContent = m.reasoningContent;
          }
          output.push(item);
          // assistant 已带完整 tool_calls，后续 tool 只负责 result
          pendingAssistantIndex = null;
          openToolGroup = true;
        } else {
          const item: ReturnType<ConversationState['buildLlmHistory']>[number] = {
            role: 'assistant',
            content: m.content,
            ...(m.dbId ? { dbId: m.dbId } : {}),
          };
          if (m.reasoningContent) {
            item.reasoningContent = m.reasoningContent;
          }
          output.push(item);
          pendingAssistantIndex = output.length - 1;
          openToolGroup = false;
        }
        prevOutputRole = 'assistant';
        continue;
      }

      if (m.role === 'tool' && m.toolResult && m.toolResult.toolCallId) {
        const toolContent = m.toolResult.result || m.content;
        const callEntry = {
          id: m.toolResult.toolCallId,
          name: m.toolResult.toolName,
          arguments: m.toolResult.arguments || {},
        };

        if (pendingAssistantIndex != null) {
          // 纯文案 assistant 后的第一个 tool：把 toolCalls 挂上去。
          // reasoningContent 一并带上（DeepSeek thinking 模式回传要求）；
          // dbId 保留（压缩定位锚点）。
          const prev = output[pendingAssistantIndex];
          output[pendingAssistantIndex] = {
            role: 'assistant',
            content: prev.content,
            toolCalls: [callEntry],
            ...(prev.reasoningContent ? { reasoningContent: prev.reasoningContent } : {}),
            ...(prev.dbId ? { dbId: prev.dbId } : {}),
          };
          pendingAssistantIndex = null;
          openToolGroup = true;
        } else if (openToolGroup) {
          // 并行/连续 tool：追加到最近一条带 toolCalls 的 assistant
          for (let i = output.length - 1; i >= 0; i--) {
            const prev = output[i];
            if (prev.role === 'assistant' && prev.toolCalls) {
              const exists = prev.toolCalls.some((tc) => tc.id === callEntry.id);
              if (!exists) {
                prev.toolCalls = [...prev.toolCalls, callEntry];
              }
              break;
            }
            if (prev.role === 'user') break;
          }
        } else {
          // 孤立 tool（UI store 里没有前导 assistant）：合成一条单 call 的 assistant
          output.push({
            role: 'assistant',
            content: '',
            toolCalls: [callEntry],
          });
          openToolGroup = true;
        }

        output.push({
          role: 'tool',
          content: toolContent,
          toolCallId: m.toolResult.toolCallId,
          ...(m.dbId ? { dbId: m.dbId } : {}),
        });
        prevOutputRole = 'tool';
      } else {
        openToolGroup = false;
      }
    }

    // 协议闭合校验：裁剪重启/崩溃残留的未闭合 tool_calls，避免 LLM 400
    return enforceToolProtocol(closeToolCallGroups(output));
  },
}));
