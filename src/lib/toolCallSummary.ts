import type { AgentMessage } from './types';
import { isDeliverableTool } from './toolCatalog';

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
    const name = message.toolResult.toolName;
    if (typeof name !== 'string' || !name.trim()) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Array.from(counts, ([toolName, count]) => ({ toolName, count }));
}

export function toolCallSummaryLabel(messages: readonly AgentMessage[]): string {
  const counts = summarizeToolCalls(messages);
  return counts.length
    ? `执行${counts.map(({ toolName }) => toolName).join(',')}`
    : '已执行工具';
}
