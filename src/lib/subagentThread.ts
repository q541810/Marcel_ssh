/**
 * subagentThread.ts —— 「同一个子 agent 的来回」在消息流里合成一张时间线卡（纯函数，无副作用）。
 *
 * 背景：子 agent 可以用 `ask_parent` 向主 agent 提问。流程是
 *   子 agent 调 ask_parent → 暂停 → 主 agent 那次 `subagent` / `local_subagent` 调用提前返回，
 *   结果 metadata 为 `{ kind: 'subagentAsk', subConversationId, askToolCallId, question, context }`
 *   → 主 agent 再调一次同一个工具、带 `continue_id` 回答（这次调用的 `prompt` 就是回答）。
 * 于是主对话里同一个子 agent 会连着出现好几张工具卡（首次派发 + 每次续派）。用户要看的是
 * 「派活 → 提问 → 回答 → 继续 → 完成」这一条线，所以把它们并成一张卡。
 *
 * 分组口径只看结构：子对话 id（结果 metadata → 参数 `continue_id`），live 与重载后一致。
 * 位置：时间线卡留在**第一次派发**的位置（锚点），后面的续派卡并进来、不再单独占行 ——
 * 卡片原地长高而不是被新位置顶一下，滚动位置和用户的阅读锚点都不会乱；代价是回答发生在
 * 很久以后时卡片离当前位置较远，所以卡片头部带状态（等待回答 / 未回答 / 继续中），
 * 子对话一侧的「回到主对话」会直接跳到这张卡。
 *
 * 另外在**子对话**一侧：重载后一次未回答的 `ask_parent`（只有 assistant 的 toolCalls、没有
 * 结果行）补一条占位的 tool 消息，让它能渲染成气泡、被跳转命中。
 */
import type { AgentMessage } from './types';
import { ASK_PARENT_TOOL, isAskParentTool, isSubagentTool } from './toolCatalog';
import { isTurnStart } from './agentTurnFold';

/** 暂停交还时 subagent 结果 metadata 的 kind。 */
export const SUBAGENT_ASK_KIND = 'subagentAsk';
/** ask_parent 被回答后结果 metadata 的 kind。 */
export const PARENT_ANSWER_KIND = 'parentAnswer';

export type AskState = 'waiting' | 'answered' | 'unanswered';
export type OutcomeState = 'running' | 'completed' | 'failed' | 'cancelled';

export type ThreadItem =
  | { kind: 'dispatch'; text: string }
  | { kind: 'ask'; question: string; context: string | null; askToolCallId: string; state: AskState }
  | { kind: 'answer'; text: string }
  | { kind: 'followUp'; text: string }
  | { kind: 'outcome'; state: OutcomeState; result: string };

export interface SubagentThread {
  subConversationId: string;
  /** 卡片标题：首次派发的 description（缺省取 prompt 首行）。 */
  title: string;
  items: ThreadItem[];
  askCount: number;
  /** 整条线此刻的状态：卡片头部的徽标。 */
  state: 'running' | 'waiting' | 'unanswered' | OutcomeState;
  /** 并入这张卡的全部消息 id（含锚点自己），按时间序。 */
  memberIds: string[];
  /** 全部调用 id（跳转按调用 id 找行时用）。 */
  toolCallIds: string[];
}

export interface DerivedMessages {
  /** 渲染用的消息：续派卡已被吸收、锚点带 `subagentThread`、未回答的 ask_parent 已补占位。 */
  messages: AgentMessage[];
  /** 被吸收的消息 id → 锚点消息 id（跳转据此落到时间线卡）。 */
  absorbed: Map<string, string>;
  threads: Map<string, SubagentThread>;
}

export interface DeriveOptions {
  /** 主对话的尾回合是否还在跑：决定「没回答的提问」是在等还是已经错过。 */
  tailActive: boolean;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? '';
  return line.trim();
}

/** 这条消息属于哪个子对话（结果 metadata 优先，其次续派参数 `continue_id`）。 */
export function subConversationIdOf(message: AgentMessage): string {
  if (message.role !== 'tool' || !message.toolResult) return '';
  if (!isSubagentTool(message.toolResult.toolName)) return '';
  const meta = message.toolResult.metadata;
  const fromMeta = str(meta?.subConversationId).trim();
  if (fromMeta) return fromMeta;
  return str(message.toolResult.arguments?.continue_id).trim();
}

/** 暂停交还的提问；不是则 null。 */
export function askHandBack(message: AgentMessage): {
  question: string;
  context: string | null;
  askToolCallId: string;
} | null {
  const meta = message.toolResult?.metadata;
  if (!meta || meta.kind !== SUBAGENT_ASK_KIND) return null;
  const context = str(meta.context).trim();
  return {
    question: str(meta.question),
    context: context || null,
    askToolCallId: str(meta.askToolCallId),
  };
}

function outcomeOf(message: AgentMessage): OutcomeState {
  if (message.isExecuting) return 'running';
  const status = str(message.toolResult?.metadata?.status);
  if (status === 'failed' || status === 'cancelled' || status === 'completed') return status;
  const tr = message.toolResult;
  if (!tr) return 'completed';
  if (tr.wasAborted) return 'cancelled';
  return tr.success && !tr.blocked ? 'completed' : 'failed';
}

/** 占位 ask_parent 消息的 id（由调用 id 唯一确定，跳转可以不查表直接构造）。 */
export function pendingAskMessageId(toolCallId: string): string {
  return `ask-pending:${toolCallId}`;
}

function lastTurnStartIndex(messages: readonly AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isTurnStart(messages[i])) return i;
  }
  return -1;
}

/** 一个子对话里最后那次还没回答的 ask_parent 调用（之后没有新的回合开头才算）。 */
export function pendingAskParent(
  messages: readonly AgentMessage[],
): { toolCallId: string; question: string; context: string | null } | null {
  const answered = new Set<string>();
  for (const m of messages) {
    if (m.role === 'tool' && !!m.toolResult && isAskParentTool(m.toolResult.toolName) && !m.isExecuting && m.toolResult.toolCallId) {
      answered.add(m.toolResult.toolCallId);
    }
  }
  const floor = lastTurnStartIndex(messages);
  for (let i = messages.length - 1; i > floor; i -= 1) {
    const m = messages[i];
    if (m.role === 'tool' && !!m.toolResult && isAskParentTool(m.toolResult.toolName) && m.isExecuting) {
      const args = m.toolResult.arguments;
      return {
        toolCallId: m.toolResult.toolCallId ?? '',
        question: str(args?.question),
        context: str(args?.context).trim() || null,
      };
    }
    if (m.role === 'assistant') {
      const calls = m.toolCalls ?? (m.toolCall ? [m.toolCall] : []);
      for (const c of calls) {
        if (isAskParentTool(c.name) && !answered.has(c.id)) {
          return {
            toolCallId: c.id,
            question: str(c.arguments?.question),
            context: str(c.arguments?.context).trim() || null,
          };
        }
      }
    }
  }
  return null;
}

/** 重载后一次未回答的 ask_parent：补一条占位 tool 消息，插在发出它的 assistant 消息之后。 */
function withPendingAskPlaceholders(messages: readonly AgentMessage[]): AgentMessage[] {
  const pending = pendingAskParent(messages);
  if (!pending) return messages as AgentMessage[];
  // live 阶段 tool 消息（执行中）本来就在，不补
  if (messages.some((m) => m.role === 'tool' && m.toolResult?.toolCallId === pending.toolCallId)) {
    return messages as AgentMessage[];
  }
  const at = messages.findIndex(
    (m) => m.role === 'assistant' && (m.toolCalls?.some((c) => c.id === pending.toolCallId) || m.toolCall?.id === pending.toolCallId),
  );
  if (at < 0) return messages as AgentMessage[];
  const issuer = messages[at];
  const args = (issuer.toolCalls ?? [issuer.toolCall!]).find((c) => c.id === pending.toolCallId)?.arguments;
  const placeholder: AgentMessage = {
    id: pendingAskMessageId(pending.toolCallId),
    role: 'tool',
    content: '',
    timestamp: issuer.timestamp,
    isExecuting: true,
    toolResult: {
      toolName: ASK_PARENT_TOOL,
      summary: '',
      result: '',
      success: true,
      blocked: false,
      arguments: args,
      toolCallId: pending.toolCallId,
    },
  };
  return [...messages.slice(0, at + 1), placeholder, ...messages.slice(at + 1)];
}

/**
 * 把消息流里同一个子对话的 subagent 调用并成时间线卡，并补齐子对话侧的占位。
 *
 * 只有「值得画时间线」的组才改写：这个子对话出现过提问，或被续派过。单次派发（绝大多数）
 * 原样返回同一个对象，既有的工具卡和它的 memo 完全不受影响。
 */
export function deriveSubagentMessages(
  source: readonly AgentMessage[],
  { tailActive }: DeriveOptions,
): DerivedMessages {
  const messages = withPendingAskPlaceholders(source);
  const absorbed = new Map<string, string>();
  const threads = new Map<string, SubagentThread>();

  const bySub = new Map<string, number[]>();
  messages.forEach((m, i) => {
    const sub = subConversationIdOf(m);
    if (!sub) return;
    const list = bySub.get(sub);
    if (list) list.push(i);
    else bySub.set(sub, [i]);
  });

  const tailFloor = lastTurnStartIndex(messages);
  const replace = new Map<number, AgentMessage>();
  const drop = new Set<number>();

  for (const [subConversationId, indices] of bySub) {
    const members = indices.map((i) => messages[i]);
    const hasAsk = members.some((m) => askHandBack(m) !== null);
    if (members.length < 2 && !hasAsk) continue;

    const first = members[0];
    const firstArgs = first.toolResult?.arguments;
    const title = str(firstArgs?.description).trim() || firstLine(str(firstArgs?.prompt)) || '子 Agent';
    const items: ThreadItem[] = [];
    let askCount = 0;
    let prevAsked = false;

    members.forEach((m, k) => {
      const args = m.toolResult?.arguments;
      const prompt = str(args?.prompt).trim();
      if (k === 0 && !str(args?.continue_id).trim()) {
        items.push({ kind: 'dispatch', text: str(args?.description).trim() || firstLine(prompt) || prompt });
      } else if (prevAsked) {
        items.push({ kind: 'answer', text: prompt });
      } else {
        items.push({ kind: 'followUp', text: prompt });
      }
      const ask = m.isExecuting ? null : askHandBack(m);
      if (ask) {
        askCount += 1;
        const hasNext = k < members.length - 1;
        // 最后一次提问没人回答：主 agent 这一轮还在跑就是「等回答」，否则是错过了
        const inTail = indices[k] > tailFloor;
        const state: AskState = hasNext ? 'answered' : tailActive && inTail ? 'waiting' : 'unanswered';
        items.push({ kind: 'ask', ...ask, state });
        prevAsked = true;
      } else {
        items.push({ kind: 'outcome', state: outcomeOf(m), result: m.isExecuting ? '' : str(m.toolResult?.result) });
        prevAsked = false;
      }
    });

    const last = items[items.length - 1];
    const state: SubagentThread['state'] =
      last.kind === 'ask' ? (last.state === 'waiting' ? 'waiting' : 'unanswered')
        : last.kind === 'outcome' ? last.state
          : 'running';

    const thread: SubagentThread = {
      subConversationId,
      title,
      items,
      askCount,
      state,
      memberIds: members.map((m) => m.id),
      toolCallIds: members.flatMap((m) => (m.toolResult?.toolCallId ? [m.toolResult.toolCallId] : [])),
    };
    threads.set(first.id, thread);
    replace.set(indices[0], {
      ...first,
      // 任一成员还在跑，整张卡就是执行中（工具分组据此不把它收进折叠组）
      isExecuting: members.some((m) => m.isExecuting) || undefined,
      subagentThread: thread,
    });
    for (let k = 1; k < indices.length; k += 1) {
      drop.add(indices[k]);
      absorbed.set(members[k].id, first.id);
    }
  }

  if (replace.size === 0 && drop.size === 0) {
    return { messages: messages as AgentMessage[], absorbed, threads };
  }
  const out: AgentMessage[] = [];
  messages.forEach((m, i) => {
    if (drop.has(i)) return;
    out.push(replace.get(i) ?? m);
  });
  return { messages: out, absorbed, threads };
}

/** 回合折叠 / 工具分组里这张卡的名字：「子 Agent · 标题（问过 N 次）」；没有提问时返回 null。 */
export function threadSummaryLabel(thread: SubagentThread | undefined): string | null {
  if (!thread || thread.askCount === 0) return null;
  return `子 Agent · ${thread.title}（问过 ${thread.askCount} 次）`;
}

/** 状态徽标文案。 */
export function threadStateLabel(state: SubagentThread['state']): string {
  switch (state) {
    case 'running': return '继续中';
    case 'waiting': return '等待主 Agent 回答';
    case 'unanswered': return '提问未回答';
    case 'completed': return '已完成';
    case 'failed': return '失败';
    case 'cancelled': return '已取消';
  }
}

// ── 跳转解析：请求里只有调用 id / 子对话 id，消息在执行时才解析 ──

/** 找到某次工具调用对应的行（tool 消息；子对话里未回答的 ask_parent 用占位 id）。 */
export function resolveToolCallMessageId(
  messages: readonly AgentMessage[],
  toolCallId: string,
): string | null {
  if (!toolCallId) return null;
  const tool = messages.find((m) => m.role === 'tool' && m.toolResult?.toolCallId === toolCallId);
  if (tool) return tool.id;
  const issuer = messages.find(
    (m) => m.role === 'assistant' && (m.toolCalls?.some((c) => c.id === toolCallId) || m.toolCall?.id === toolCallId),
  );
  return issuer ? pendingAskMessageId(toolCallId) : null;
}

/** 找到某个子对话的时间线卡 / 首张工具卡（原始消息里最早的那条）。 */
export function resolveSubagentThreadMessageId(
  messages: readonly AgentMessage[],
  subConversationId: string,
): string | null {
  if (!subConversationId) return null;
  const hit = messages.find((m) => subConversationIdOf(m) === subConversationId);
  return hit?.id ?? null;
}
