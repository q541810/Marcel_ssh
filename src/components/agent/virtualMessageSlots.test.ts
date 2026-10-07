import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@/lib/types';
import { buildMessageRows } from './agentMessageRows';
import { virtualMessageSlots } from './virtualMessageSlots';

const tools = Array.from({ length: 4 }, (_, index): AgentMessage => ({
  id: `t${index}`, role: 'tool', content: '', timestamp: '',
  toolResult: { toolName: 'bash', success: true, result: '', summary: '', blocked: false },
}));
const options = { foldTurns: false, tailActive: false, expandedTurns: {}, expandedGroups: new Set<string>(), matchedIds: new Set<string>() };

describe('virtual message collections', () => {
  it('keeps all reserved indices while collecting open members under their stable group slot', () => {
    const closed = virtualMessageSlots(tools, buildMessageRows(tools, options).rows);
    const open = virtualMessageSlots(tools, buildMessageRows(tools, { ...options, expandedGroups: new Set(['group:tools:t0']) }).rows);
    expect(open.map((slot) => slot.key)).toEqual(closed.map((slot) => slot.key));
    expect(open[0].rows?.map((row) => row.key)).toEqual(['group:tools:t0', ...tools.map((tool) => `message:${tool.id}`)]);
    expect(open.slice(1).every((slot) => !slot.row && !slot.rows)).toBe(true);
  });

  it('preserves interleaved executing tools in chronological order inside the collection', () => {
    const running = tools.map((tool, index) => ({ ...tool, isExecuting: index % 2 === 1 }));
    const rows = buildMessageRows(running, { ...options, expandedGroups: new Set(['group:tools:t0']) }).rows;
    expect(virtualMessageSlots(running, rows)[0].rows?.map((row) => row.key)).toEqual(['group:tools:t0', ...tools.map((tool) => `message:${tool.id}`)]);
  });

  it('keeps normal messages in separate virtual slots', () => {
    const messages: AgentMessage[] = [{ id: 'text', role: 'assistant', content: 'result', timestamp: '' }, ...tools];
    const slots = virtualMessageSlots(messages, buildMessageRows(messages, options).rows);
    expect(slots[0].rows?.map((row) => row.key)).toEqual(['message:text']);
    expect(slots[1].rows?.map((row) => row.key)).toEqual(['group:tools:t0']);
  });

  it.each([false, true])('preserves message and deliverable order with the whole turn open=%s', (open) => {
    const messages: AgentMessage[] = [
      { id: 'user', role: 'user', content: 'run', timestamp: '', turnState: 'completed' },
      ...tools.slice(0, 2),
      { ...tools[0], id: 'chart', toolResult: { ...tools[0].toolResult!, toolName: 'render_html' } },
      { id: 'comment', role: 'assistant', content: 'progress', timestamp: '' },
      ...tools.slice(2),
      { id: 'answer', role: 'assistant', content: 'done', timestamp: '' },
    ];
    const rows = buildMessageRows(messages, { ...options, foldTurns: true,
      expandedTurns: { 'u:user': open }, expandedGroups: new Set(['group:tools:t0', 'group:tools:t2']) }).rows;
    const flattened = virtualMessageSlots(messages, rows).flatMap((slot) => slot.rows ?? []);
    expect(flattened.map((row) => row.key)).toEqual(rows.map((row) => row.key));
    expect(flattened.some((row) => row.key === 'message:chart')).toBe(true);
    expect(flattened[flattened.length - 1]?.key).toBe('message:answer');
  });
});
