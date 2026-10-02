import type { AgentMessage } from '@/lib/types';
import { segmentTurns, type TurnSegment } from '@/lib/agentTurnFold';
import { isExplorationTool, isPlanTool } from '@/lib/toolCatalog';

export type ToolGroupKind = 'exploration' | 'plan';
export type MessageRow =
  | { key: string; kind: 'message'; message: AgentMessage; grouped?: boolean }
  | { key: string; kind: 'turn'; segment: TurnSegment; open: boolean }
  | { key: string; kind: 'group'; group: ToolGroupKind; messages: AgentMessage[]; open: boolean };

export function messageGroup(message: AgentMessage): ToolGroupKind | null {
  if (message.role !== 'tool' || !message.toolResult) return null;
  const name = message.toolResult.toolName;
  return isExplorationTool(name) ? 'exploration' : isPlanTool(name) ? 'plan' : null;
}

interface Options {
  foldTurns: boolean;
  tailActive: boolean;
  expandedTurns: Record<string, boolean>;
  expandedGroups: ReadonlySet<string>;
  matchedIds: ReadonlySet<string>;
}

/** Flatten *open* groups too: one long turn must not become one giant virtual row. */
export function buildMessageRows(messages: AgentMessage[], options: Options) {
  const rows: MessageRow[] = [];
  const forcedTurns: string[] = [];
  const forcedGroups: string[] = [];
  const add = (message: AgentMessage, grouped = false) =>
    rows.push({ key: `message:${message.id}`, kind: 'message', message, grouped });
  const group = (source: readonly AgentMessage[]) => {
    const visible = source.filter((m) =>
      m.role !== 'assistant' || m.isLoading || m.content || m.reasoningContent || m.toolCall,
    );
    for (let i = 0; i < visible.length;) {
      const kind = messageGroup(visible[i]);
      let end = i + 1;
      if (kind) while (end < visible.length && messageGroup(visible[end]) === kind) end++;
      if (kind && end - i >= (kind === 'plan' ? 2 : 4)) {
        const members = visible.slice(i, end);
        const key = `group:${kind}:${members[0].id}`;
        const forced = members.some((m) => options.matchedIds.has(m.id));
        if (forced) forcedGroups.push(key);
        const open = options.expandedGroups.has(key) || forced;
        rows.push({ key, kind: 'group', group: kind, messages: members, open });
        if (open) members.forEach((m) => add(m, true));
        i = end;
      } else {
        add(visible[i++]);
      }
    }
  };

  if (!options.foldTurns) group(messages);
  else for (const segment of segmentTurns(messages, { tailActive: options.tailActive })) {
    if (!segment.foldable) {
      group(segment.messages);
      continue;
    }
    const forced = segment.foldMembers.some((m) => options.matchedIds.has(m.id));
    if (forced) forcedTurns.push(segment.key);
    const open = !!options.expandedTurns[segment.key] || forced;
    add(segment.messages[0]);
    rows.push({ key: `turn:${segment.key}`, kind: 'turn', segment, open });
    group(open ? segment.foldMembers : segment.deliverableMembers);
    if (segment.answerIndex !== null) {
      // Preserve trailing notices/tools too; folding must never remove actual messages.
      group(segment.messages.slice(segment.answerIndex));
    }
  }
  return { rows, forcedTurns, forcedGroups };
}

/** Only a pure prepend may use the virtualizer's reverse-loading size cache. */
export function isRowPrepend(previous: readonly MessageRow[], next: readonly MessageRow[]) {
  const added = next.length - previous.length;
  return previous.length > 0 && added > 0
    && previous.every((row, index) => row.key === next[index + added].key);
}
