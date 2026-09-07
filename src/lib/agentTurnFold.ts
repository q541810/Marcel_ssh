/**
 * agentTurnFold.ts — 已结束回合（turn）的过程折叠分段纯函数。
 *
 * 语义（用户拍板 + 对齐 DSH「x 次工具调用 · x 条消息」的回合折叠思路）：
 * - 回合边界：user 消息是硬边界。相邻两条 user 消息之间 = 一个回合；
 *   被 rollback / 新 user 打断的半截过程也算一个（已结束的）回合。
 * - 已结束判定：回合内最后一条「有回复内容的纯文本 assistant」= 答案；
 *   若回合以 tool / thinking / 空 assistant 收尾（无纯文本答案），
 *   则这个回合**正在流 / 被打断**，不可折叠（等待后续补完）。
 * - 只折叠「长回合」：过程 tool 消息 >= TOOL_FOLD_MIN 才默认折叠；
 *   短回合保持展开，避免过度压缩（开关关闭时完全不折叠）。
 * - 计数口径（只数最终答案之前）：toolCallCount = tool 消息条数；
 *   messageCount = 有回复内容的 assistant 消息数（含 thinking/含 tool_calls）；
 *   subagentCount = toolResult.toolName 为 subagent（或历史 task）的 tool 消息数。
 * - compaction 卡片 / system 消息 / user 是「不折叠锚点」：过程区不含它们。
 *
 * 本模块只做「分段 + 计数」，不做任何渲染/状态 —— 纯函数，便于单测。
 */

import type { AgentMessage } from "@/lib/types";

/** 过程 tool 消息达到该条数才把回合收成折叠（默认折叠阈值，对齐
 *  ExplorationGroup 探索工具 4 条 / plan 2 条的同类“组折叠”直觉）。 */
export const TOOL_FOLD_MIN = 3;

/** 折叠控制行文案里显示的最大计数（超过显示 “n+”，避免超长回合撑爆标签）。 */
export const COUNT_CAP = 99;

/** 有回复内容的 assistant：内容 / thinking / tool_calls / loading 骨架。 */
export function hasAssistantContent(msg: AgentMessage): boolean {
  if (msg.role !== "assistant") return false;
  if (msg.isLoading) return true;
  if (msg.content) return true;
  if (msg.reasoningContent) return true;
  if (msg.toolCall) return true;
  if (msg.toolCalls && msg.toolCalls.length > 0) return true;
  return false;
}

/** 纯文本答案：有回复内容的 assistant 且不含任何 tool_calls。 */
export function isFinalAnswer(msg: AgentMessage): boolean {
  if (msg.role !== "assistant" || msg.isLoading) return false;
  if (!msg.content && !msg.reasoningContent) return false;
  if (msg.toolCall) return false;
  if (msg.toolCalls && msg.toolCalls.length > 0) return false;
  return true;
}

export interface TurnSegment {
  /** 稳定 key：会话内不重复即可。用首条 user 消息 id 或偏移量编码。 */
  readonly key: string;
  /** 回合内全部消息（含 user 开头的完整消息序列）。 */
  readonly messages: readonly AgentMessage[];
  /** 控制行插入位置：回合内第一条 user 之后的索引（0 = 紧跟 user）。 */
  readonly controlIndex: number;
  /** 最终答案在 messages 中的下标；null = 回合未结束（不可折叠）。 */
  readonly answerIndex: number | null;
  /** 折叠区内「可折叠成员」消息（答案之前的 tool / assistant 过程行）。 */
  readonly foldMembers: readonly AgentMessage[];
  /** 计数（只数答案之前）。 */
  readonly toolCallCount: number;
  readonly messageCount: number;
  readonly subagentCount: number;
  /** 是否达到“长回合”阈值、可被折叠。 */
  readonly foldable: boolean;
}

function isSubagentToolResult(msg: AgentMessage): boolean {
  return (
    msg.role === 'tool' &&
    !!msg.toolResult &&
    (msg.toolResult.toolName === 'subagent' || msg.toolResult.toolName === 'task')
  );
}

/** 回合内所有消息（含开头的 user）。 */
function collectTurn(
  messages: readonly AgentMessage[],
  start: number,
  end: number, // exclusive
): { turn: readonly AgentMessage[]; userIndex: number } {
  const turn = messages.slice(start, end);
  // user 可能不在回合最前（如 compaction 打断后新 user），取第一条 user。
  const userIndex = turn.findIndex((m) => m.role === "user");
  return { turn, userIndex };
}

function turnKey(turn: readonly AgentMessage[], start: number): string {
  const firstUser = turn.find((m) => m.role === "user");
  if (firstUser?.id) return `u:${firstUser.id}`;
  // 兜底（理论上 user 总是存在）：用偏移量。
  return `i:${start}`;
}

/**
 * 把一段消息流切成「回合段」，逐段算出答案/计数/可折叠性。
 *
 * MSL 无 DSH 的 turn/end 事件；一个任务回合 = 一条 user 起、直到任务结束
 * （handleDone）的连续消息。任务进行中模型会在 tool 之间输出多条纯文本
 * assistant（每轮 LLM 调用各成一条），因此「段内最后一条纯文本 assistant」
 * 不能当作回合结束 —— 它可能是任务中途的插话。真正的回合结束信号是
 * **任务运行态**：`tailActive=true`（正在跑的任务的尾回合）永不折叠，
 * 任务结束（isRunning=false，尾部收束为纯文本总结）才允许折叠。
 *
 * @param messages 已按时间正序排列的完整消息流（调用方负责切片窗口）。
 * @param opts.tailActive 尾回合（最后一条 user 之后的回合）是否处于运行中
 *   （对应 isRunning）；true 时该尾回合强制不可折叠。
 * @returns 回合段数组（保持原顺序）。
 */
export function segmentTurns(
  messages: readonly AgentMessage[],
  opts?: { tailActive?: boolean },
): TurnSegment[] {
  const segments: TurnSegment[] = [];
  const tailActive = opts?.tailActive ?? false;
  let i = 0;
  const n = messages.length;
  while (i < n) {
    if (messages[i].role !== "user") {
      // 会话可能以 system / 孤立过程消息开头（历史加载、rollback 残留）。
      // 它们不构成回合，原样渲染、不参与折叠。
      segments.push({
        key: `lone:${i}`,
        messages: [messages[i]],
        controlIndex: 0,
        answerIndex: null,
        foldMembers: [],
        toolCallCount: 0,
        messageCount: 0,
        subagentCount: 0,
        foldable: false,
      });
      i += 1;
      continue;
    }
    // 回合 = 该 user 起到下一条 user 前（含半截被打断的过程）。
    let j = i + 1;
    while (j < n && messages[j].role !== "user") j += 1;
    const { turn, userIndex } = collectTurn(messages, i, j);
    // 尾回合 = 该 user 之后没有更新的 user（回合延伸到消息流末尾）。
    const isTail = j >= n;

    // 找最后一条纯文本答案。
    let answerIndex: number | null = null;
    for (let k = turn.length - 1; k >= 0; k -= 1) {
      if (isFinalAnswer(turn[k])) {
        answerIndex = k;
        break;
      }
    }
    // 半截回合（没有纯文本答案）→ 不可折叠，原样渲染。
    if (answerIndex === null) {
      segments.push({
        key: turnKey(turn, i),
        messages: turn,
        controlIndex: userIndex + 1,
        answerIndex: null,
        foldMembers: [],
        toolCallCount: 0,
        messageCount: 0,
        subagentCount: 0,
        foldable: false,
      });
      i = j;
      continue;
    }

    // 计数：只数答案之前（含答案之前的所有 process 行；答案本身不计）。
    const before = turn.slice(0, answerIndex);
    let toolCallCount = 0;
    let messageCount = 0;
    let subagentCount = 0;
    for (const m of before) {
      if (m.role === "tool") {
        toolCallCount += 1;
        if (isSubagentToolResult(m)) subagentCount += 1;
      } else if (hasAssistantContent(m)) {
        messageCount += 1;
      }
    }

    // 折叠成员 = 答案之前的 tool / assistant 过程行（user / system 除外）。
    const foldMembers = before.filter(
      (m) => m.role === "tool" || (m.role === "assistant" && hasAssistantContent(m)),
    );
    // 任务尚未结束（尾回合且正在跑）→ 不折叠：模型可能继续输出 tool 或
    // 更多文本，现在折叠会在任务中途把过程收走（“干一半收起”）。
    // 过程中间夹 system（compaction 卡等永显锚点）→ 也不折叠。
    const foldable = !(isTail && tailActive)
      && toolCallCount >= TOOL_FOLD_MIN
      && !before.some((m) => m.role === "system");

    segments.push({
      key: turnKey(turn, i),
      messages: turn,
      controlIndex: userIndex + 1,
      answerIndex,
      foldMembers,
      toolCallCount,
      messageCount,
      subagentCount,
      foldable,
    });
    i = j;
  }
  return segments;
}

/**
 * 生成本地化折叠控制行文案（MSL 风格，对齐探索组「已探索 n 次读取」）。
 *
 * @param seg 回合段。
 * @returns 「已执行 n 步 · 共 m 条消息」/「已思考 n 轮 · 共 m 条消息」/「查看过程」。
 */
export function turnFoldLabel(seg: {
  readonly toolCallCount: number;
  readonly messageCount: number;
  readonly subagentCount: number;
}): string {
  const tool = seg.toolCallCount;
  const msg = seg.messageCount;
  const sub = seg.subagentCount;
  const toolText = tool > 0 ? `已执行 ${tool} 步` : null;
  const msgText = msg > 0 ? `共 ${msg} 条消息` : null;
  const subText = sub > 0 ? `${sub} 个任务` : null;
  const parts = [toolText, subText, msgText].filter(Boolean) as string[];
  if (parts.length > 0) return parts.join(" · ");
  return "查看过程";
}

/** 折叠/展开时的按钮文案。 */
export function turnFoldToggleLabel(open: boolean): string {
  return open ? "收起过程" : "查看过程";
}
