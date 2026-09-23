// Token 用量的显示口径 —— 桌面端与移动端共用的**唯一来源**。
//
// 这里只放纯函数（格式化、口径换算、降级判定），不放组件、不碰 store：
// 数字怎么读、什么时候显示 `—`、什么时候加 `~`、环画多大，双端必须一致，
// 各写一份必然漂（这两端已经各自长出一套用量显示过一次了）。

import type { AgentConversation, ConversationUsage, LastContextUsage } from './types';

/**
 * 压缩触发的阈值比例（窗口 × 它 = 触发预防式压缩）。
 *
 * 与后端 `agent::context::DEFAULT_THRESHOLD_RATIO` 是**同一个数**，由
 * `tokenUsage.test.ts` 读 Rust 源码钉住 —— 改后端不改这里，占用条上的
 * 刻度线就会指错地方。
 */
export const COMPACT_THRESHOLD_RATIO = 0.8;

/** 精确计数：千分位（明细行用它，「84,213」比「84.2K」更有信息量）。 */
export function formatExactTokens(value: number): string {
  return Math.round(value).toLocaleString();
}

/**
 * 缩写计数（`◔` 旁、空间紧的地方用它）：<1000 原样；K/M 时 ≥100 取整、
 * <100 保留一位小数（`12.2K`、`980K`、`1.2M`）。
 *
 * 对齐 DSH `formatTokens`：同一数量级的数字宽度一致，读数不会跳来跳去。
 */
export function formatCompactTokens(value: number): string {
  const scaled = (n: number) => (n >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10));
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) return `${scaled(value / 1_000)}K`;
  return `${scaled(value / 1_000_000)}M`;
}

/** 百分比：整数不带小数，带小数保留一位（`42%` / `99.9%`）。 */
export function formatPercent(percent: number): string {
  return Number.isInteger(percent) ? String(percent) : percent.toFixed(1);
}

/**
 * 缓存命中率（0–100；`null` = 算不出来：没有输入）。
 *
 * **部分命中永远不显示成 100** —— 差一个 token 时真实值是 99.9995%，
 * 四舍五入就是 100%，而用户会以为整段输入都命中了缓存（实际那一个 token
 * 是按全价算的）。宁可显示 99.9%。
 */
export function cacheHitPercent(cachedReadTokens: number, promptTokens: number): number | null {
  if (promptTokens <= 0) return null;
  if (cachedReadTokens <= 0) return 0;
  if (promptTokens - cachedReadTokens <= 0) return 100;
  const oneDecimal = Math.round((cachedReadTokens / promptTokens) * 1000) / 10;
  return oneDecimal >= 100 ? 99.9 : oneDecimal;
}

/**
 * 未缓存输入 = 输入 − 缓存读取（`promptTokens` 在 OpenAI 兼容协议里是**含**
 * 缓存的总量，不是 DSH 那种互斥的 uncached 桶）。
 *
 * `null` = 该渠道没报缓存读取，这条**不显示**（显示 0 会被读成「一个都没命中」）。
 */
export function uncachedInputTokens(usage: ConversationUsage | undefined): number | null {
  if (!usage || usage.cachedReadTokens == null) return null;
  return Math.max(0, usage.promptTokens - usage.cachedReadTokens);
}

/** 有没有可显示的用量记录（区别于「用了 0 token」：老会话整块缺失 = 没有）。 */
export function hasUsage(usage: ConversationUsage | undefined): boolean {
  if (!usage) return false;
  return hasTotals(usage) || usage.lastContext != null;
}

/**
 * 累计三件套有没有**真数据**。
 *
 * 与 [`hasUsage`] 的区别：那个还看「最近一次请求的快照」。只有快照、没有累计的
 * 情况是真会出现的（渠道忽略了 `include_usage`，一轮都没报过用量），这时累计段
 * **不能显示 0** —— 那是把「不知道」写成「没花」，用户会以为这个会话白跑。
 */
export function hasTotals(usage: ConversationUsage | undefined): boolean {
  if (!usage) return false;
  return (
    usage.promptTokens > 0 ||
    usage.completionTokens > 0 ||
    usage.totalTokens > 0 ||
    usage.reasoningTokens != null ||
    usage.cachedReadTokens != null
  );
}

/** 累计明细（界面直接据此逐行渲染）。 */
export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** `null` = 该渠道从未报过（这条不渲染），不是 0。 */
  reasoningTokens: number | null;
  cachedReadTokens: number | null;
  uncachedInputTokens: number | null;
  cacheHitPercent: number | null;
}

/** 把用量折成明细行。没有累计数据 → `null`，界面另说一句（不是显示 0）。 */
export function usageTotals(usage: ConversationUsage | undefined): UsageTotals | null {
  if (!usage || !hasTotals(usage)) return null;
  const cached = usage.cachedReadTokens ?? null;
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    reasoningTokens: usage.reasoningTokens ?? null,
    cachedReadTokens: cached,
    uncachedInputTokens: uncachedInputTokens(usage),
    cacheHitPercent: cached == null ? null : cacheHitPercent(cached, usage.promptTokens),
  };
}

/** 上下文占用环要用的全部数字（`null` 字段各自代表一种「这条不显示」）。 */
export interface ContextMeterView {
  /** 生效窗口 tokens；0 = 未配置。 */
  windowTokens: number;
  /** 最近一次请求的 prompt 总量；`null` = 还没有过请求。 */
  usedTokens: number | null;
  /** `usedTokens` 是否为本地估算（provider 没报用量）→ 加 `~`。 */
  estimated: boolean;
  /** 占用百分比；窗口未配置或没有用量时为 `null`（不画弧）。 */
  percent: number | null;
  /** 请求构成估算；`null` = 没有（还没跑过 / 老会话）。 */
  breakdown: { system: number; tools: number; messages: number } | null;
}

/** 三段构成之和（分段条按它算各段宽度）。 */
export function breakdownTotal(breakdown: ContextMeterView['breakdown']): number {
  if (!breakdown) return 0;
  return breakdown.system + breakdown.tools + breakdown.messages;
}

/**
 * 占用环的读数。窗口来自**后端 overlay**（`conversation.contextWindow`），
 * 前端不自己解析模型窗口 —— 压缩阈值用的是同一个数字。
 *
 * 降级都在这里定：窗口没配 → `percent = null`（不画弧，但仍显示已用值）；
 * 还没跑过请求 → `usedTokens = null`（显示 `—`，不显示 0）。
 */
export function contextMeterView(
  usage: ConversationUsage | undefined,
  windowTokens: number | undefined,
): ContextMeterView {
  const window = windowTokens && windowTokens > 0 ? windowTokens : 0;
  const last: LastContextUsage | undefined = usage?.lastContext;
  const usedTokens = last ? last.usedTokens : null;
  const percent =
    window > 0 && usedTokens != null
      ? Math.min(100, Math.round((usedTokens / window) * 100))
      : null;
  return {
    windowTokens: window,
    usedTokens,
    estimated: last?.estimated ?? false,
    percent,
    breakdown: last
      ? {
          system: last.systemTokens,
          tools: last.toolsTokens,
          messages: last.messageTokens,
        }
      : null,
  };
}

/** 一个会话的用量视图：**实时事件优先，落库数据兜底**。 */
export interface ConversationUsageView {
  usage: ConversationUsage;
  windowTokens: number;
}

/**
 * 把「实时事件」与「会话数据（含落库用量）」合成界面读数。
 *
 * 事件是覆盖语义（后端写库后发同一个数字），所以实时值永远比落库值新：
 * 拿到事件就用事件，没拿到就用会话数据（重启后打开会话走这条路）。
 * 两者都没有 → `null`，界面显示 `—`。
 *
 * 窗口取事件里的（那次请求真正跑的窗口），没有事件时取会话 overlay 的。
 */
export function conversationUsageView(
  live: { usage: ConversationUsage; windowTokens: number } | undefined,
  conversation: AgentConversation | undefined,
): ConversationUsageView | null {
  if (live) return live;
  if (!conversation) return null;
  const usage: ConversationUsage = conversation.usage ?? {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  return { usage, windowTokens: conversation.contextWindow ?? 0 };
}

/**
 * 流事件 → 落库形状。事件的字段是平的（写库后一次性发出），落库/会话数据
 * 是「累计 + `lastContext`」两层；这里是两者之间唯一的桥。
 */
export function usageFromContextEvent(ev: {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedReadTokens?: number;
  usedTokens: number;
  estimated: boolean;
  systemTokens: number;
  toolsTokens: number;
  messageTokens: number;
}): ConversationUsage {
  return {
    promptTokens: ev.promptTokens,
    completionTokens: ev.completionTokens,
    totalTokens: ev.totalTokens,
    reasoningTokens: ev.reasoningTokens,
    cachedReadTokens: ev.cachedReadTokens,
    lastContext: {
      usedTokens: ev.usedTokens,
      estimated: ev.estimated,
      systemTokens: ev.systemTokens,
      toolsTokens: ev.toolsTokens,
      messageTokens: ev.messageTokens,
    },
  };
}
