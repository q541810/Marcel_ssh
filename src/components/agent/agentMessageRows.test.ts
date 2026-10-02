import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@/lib/types';
import { segmentTurns } from '@/lib/agentTurnFold';
import { buildMessageRows, isRowPrepend } from './agentMessageRows';

const message = (id: string, role: AgentMessage['role'] = 'assistant'): AgentMessage =>
  ({ id, role, content: id, timestamp: '' });
const tool = (id: string, name = 'bash'): AgentMessage => ({
  ...message(id, 'tool'),
  toolResult: { toolName: name, summary: name, result: id, success: true, blocked: false },
});
const defaults = {
  foldTurns: true, tailActive: false, expandedTurns: {}, expandedGroups: new Set<string>(),
  matchedIds: new Set<string>(),
};
const ids = (rows: ReturnType<typeof buildMessageRows>['rows']) =>
  rows.flatMap((row) => row.kind === 'message' ? [row.message.id] : []);

describe('virtual message row model', () => {
  it('flattens a thousand-step expanded turn, preserving stable message keys', () => {
    const messages = [message('user', 'user'), ...Array.from({ length: 1000 }, (_, i) => tool(`t${i}`)), message('answer')];
    const closed = buildMessageRows(messages, defaults).rows;
    expect(ids(closed)).toEqual(['user', 'answer']);
    const key = segmentTurns(messages)[0].key;
    const open = buildMessageRows(messages, { ...defaults, expandedTurns: { [key]: true } }).rows;
    expect(open).toHaveLength(1003);
    expect(ids(open)).toHaveLength(1002);
    expect(open[0].key).toBe(closed[0].key);
    expect(open[open.length - 1].key).toBe(closed[closed.length - 1].key);
  });
  it('keeps deliverables in both folded and open views exactly once', () => {
    const messages = [message('user', 'user'), tool('a'), tool('viz', 'render_html'), tool('b'), tool('c'), message('answer')];
    const closed = buildMessageRows(messages, defaults).rows;
    const key = segmentTurns(messages)[0].key;
    const open = buildMessageRows(messages, { ...defaults, expandedTurns: { [key]: true } }).rows;
    expect(ids(closed)).toEqual(['user', 'viz', 'answer']);
    expect(ids(open).filter((id) => id === 'viz')).toHaveLength(1);
    expect(open.find((r) => r.key === 'message:viz')?.key).toBe(closed[2].key);
  });
  it('flattens nested exploration groups and opens both levels for search', () => {
    const messages = [message('user', 'user'), ...Array.from({ length: 600 }, (_, i) => tool(`r${i}`, 'read_file')), message('answer')];
    const model = buildMessageRows(messages, { ...defaults, matchedIds: new Set(['r500']) });
    expect(model.forcedTurns).toHaveLength(1);
    expect(model.forcedGroups).toHaveLength(1);
    expect(model.rows).toHaveLength(604);
    expect(ids(model.rows)).toContain('r500');
  });
  it.each(['cancelled', 'failed', 'interrupted', 'running'] as const)('does not fold %s turns', (turnState) => {
    const messages = [{ ...message('user', 'user'), turnState }, tool('a'), tool('b'), tool('c'), message('answer')];
    expect(ids(buildMessageRows(messages, defaults).rows)).toHaveLength(5);
  });
  it('handles old/empty history without mutating data and preserves trailing messages', () => {
    const messages = [message('user', 'user'), tool('a'), tool('b'), tool('c'), message('answer'), tool('tail')];
    const snapshot = JSON.stringify(messages);
    expect(ids(buildMessageRows(messages, defaults).rows)).toContain('tail');
    expect(buildMessageRows([], defaults).rows).toEqual([]);
    expect(JSON.stringify(messages)).toBe(snapshot);
  });
  it('uses reverse loading only for a pure prepend, not appends or group insertions', () => {
    const rows = buildMessageRows([message('a'), message('b')], defaults).rows;
    const prepend = buildMessageRows([message('old'), message('a'), message('b')], defaults).rows;
    expect(isRowPrepend(rows, prepend)).toBe(true);
    expect(isRowPrepend(rows, [...rows, prepend[0]])).toBe(false);
    expect(isRowPrepend(rows, [rows[0], prepend[0], rows[1]])).toBe(false);
    expect(isRowPrepend([], rows)).toBe(false);
  });
});
