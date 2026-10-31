import type { AgentMessage } from './types';
import { isDeliverableTool } from './toolCatalog';
import { threadSummaryLabel } from './subagentThread';

export interface ToolCallCount {
  toolName: string;
  count: number;
}

/** Successful deliverables remain visible rather than becoming process history. */
export function isDeliveredToolResult(message: AgentMessage): boolean {
  return message.role === 'tool'
    && !!message.toolResult
    && isDeliverableTool(message.toolResult.toolName)
    && message.toolResult.success
    && !message.toolResult.blocked;
}

/** Keep raw names and first-seen order, including unknown plugin/MCP tools. */
export function summarizeToolCalls(messages: readonly AgentMessage[]): ToolCallCount[] {
  const counts = new Map<string, number>();
  for (const message of messages) {
    if (message.role !== 'tool' || message.isExecuting || !message.toolResult
      || isDeliveredToolResult(message)) continue;
    // 问过主 Agent 的子 agent 时间线卡：折叠摘要里写「子 Agent · 标题（问过 N 次）」，一张卡一项
    const name = threadSummaryLabel(message.subagentThread) ?? message.toolResult.toolName;
    if (typeof name !== 'string' || !name.trim()) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Array.from(counts, ([toolName, count]) => ({ toolName, count }));
}

/**
 * 工具名后的执行次数标记：重复执行（≥2 次）才写 `*n`，只执行一次的保持干净
 * （`write*1` 只是噪音）。可见文字与 title / aria-label 共用它，两边不会各写各的。
 */
export function toolCallCountSuffix(count: number): string {
  return count >= 2 ? `*${count}` : '';
}

export function toolCallSummaryLabel(messages: readonly AgentMessage[]): string {
  const counts = summarizeToolCalls(messages);
  return counts.length
    ? `执行${counts.map(({ toolName, count }) => `${toolName}${toolCallCountSuffix(count)}`).join(',')}`
    : '已执行工具';
}
