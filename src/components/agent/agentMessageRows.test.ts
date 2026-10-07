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
    const open = buildMessageRows(messages, {
      ...defaults, expandedTurns: { [key]: true }, expandedGroups: new Set(['group:tools:t0']),
    }).rows;
    expect(open).toHaveLength(1004);
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
  it('flattens nested tool groups and opens both levels for search', () => {
    const messages = [message('user', 'user'), ...Array.from({ length: 600 }, (_, i) => tool(`r${i}`, 'read_file')), message('answer')];
    const model = buildMessageRows(messages, { ...defaults, matchedIds: new Set(['r500']) });
    expect(model.forcedTurns).toHaveLength(1);
    expect(model.forcedGroups).toHaveLength(1);
    expect(model.rows).toHaveLength(604);
    expect(ids(model.rows)).toContain('r500');
  });
  it.each(['cancelled', 'failed', 'interrupted', 'running'] as const)('does not fold %s turns', (turnState) => {
    const messages = [{ ...message('user', 'user'), turnState }, tool('a'), tool('b'), tool('c'), message('answer')];
    const rows = buildMessageRows(messages, defaults).rows;
    expect(rows.some((r) => r.kind === 'turn')).toBe(false);
    expect(rows.find((r) => r.kind === 'group')?.messages).toHaveLength(3);
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
  it('groups mixed names after two calls and keeps single tools visible', () => {
    const rows = buildMessageRows([tool('a', 'edit_file'), tool('b', 'write_file'), tool('c', 'bash')], defaults).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'group', group: 'tools', key: 'group:tools:a' });
    expect(ids(buildMessageRows([tool('a')], defaults).rows)).toEqual(['a']);
  });
  it('keeps executing calls outside the count and anchors groups to dispatch order', () => {
    const running = { ...tool('first'), isExecuting: true };
    const rows = buildMessageRows([running, tool('second', 'edit_file')], defaults).rows;
    expect(rows[0]).toMatchObject({ kind: 'group', key: 'group:tools:first', messages: [tool('second', 'edit_file')] });
    expect(ids(rows)).toEqual(['first']);
    const completed = buildMessageRows([tool('first'), tool('second', 'edit_file')], defaults).rows;
    expect(completed[0].key).toBe(rows[0].key);
    expect(buildMessageRows([running, { ...tool('second'), isExecuting: true }], defaults).rows.every((r) => r.kind === 'message')).toBe(true);
  });
  it('never hides an executing card in a completed-looking turn', () => {
    const messages = [
      { ...message('user', 'user'), turnState: 'completed' as const },
      tool('a'), { ...tool('b'), isExecuting: true }, tool('c'), message('answer'),
    ];
    const rows = buildMessageRows(messages, defaults).rows;
    expect(rows.some((r) => r.kind === 'turn')).toBe(false);
    expect(ids(rows)).toEqual(['user', 'b', 'answer']);
  });
  it('preserves malformed history and successful deliverables as group boundaries', () => {
    const missingResult = message('missing', 'tool');
    const missingName = tool('nameless', '');
    const delivered = tool('chart', 'render_html');
    const messages = [tool('a'), missingResult, tool('b'), missingName, tool('c'), delivered, tool('d')];
    const snapshot = JSON.stringify(messages);
    expect(ids(buildMessageRows(messages, defaults).rows)).toEqual(messages.map((m) => m.id));
    expect(JSON.stringify(messages)).toBe(snapshot);
    const failed = { ...delivered, toolResult: { ...delivered.toolResult!, success: false } };
    expect(buildMessageRows([tool('a'), failed], defaults).rows[0]).toMatchObject({ kind: 'group' });
  });
  it('preserves text and notice boundaries instead of merging unrelated calls', () => {
    const messages = [tool('a'), message('text'), tool('b'), message('notice', 'notice'), tool('c')];
    expect(ids(buildMessageRows(messages, defaults).rows)).toEqual(messages.map((m) => m.id));
  });
  it('groups across invisible history dispatch records without discarding stored messages', () => {
    const parallel: AgentMessage = {
      ...message('parallel'), content: '',
      toolCalls: [{ id: 'call', name: 'bash', arguments: {}, disposition: 'Allow' }],
    };
    const messages = [tool('a'), parallel, tool('b')];
    const snapshot = JSON.stringify(messages);
    const rows = buildMessageRows(messages, defaults).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'group', messages: [messages[0], messages[2]] });
    expect(JSON.stringify(messages)).toBe(snapshot);
  });

  it.each([3, 5, 12])('groups all %i mixed tools across sequential dispatches in history and live view', (count) => {
    const names = ['bash', 'write_file', 'create_plan', 'update_plan_item', 'mcp.custom', 'plugin.custom'];
    const history = Array.from({ length: count }, (_, i) => [
      { ...message(`dispatch${i}`), content: '', reasoningContent: 'archived thought',
        toolCalls: [{ id: `call${i}`, name: names[i % names.length], arguments: {}, disposition: 'Allow' as const }] },
      tool(`tool${i}`, names[i % names.length]),
    ]).flat();
    const options = { ...defaults, foldTurns: false };
    const completed = buildMessageRows(history, options).rows;
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ kind: 'group', key: 'group:tools:tool0' });
    if (completed[0].kind === 'group') expect(completed[0].messages).toHaveLength(count);

    const live = history.map((m) => m.id === `tool${count - 1}` ? { ...m, isExecuting: true } : m);
    const running = buildMessageRows(live, options).rows;
    expect(running).toHaveLength(2);
    expect(running[0]).toMatchObject({ kind: 'group', key: completed[0].key });
    if (running[0].kind === 'group') expect(running[0].messages).toHaveLength(count - 1);
    expect(ids(running)).toEqual([`tool${count - 1}`]);
  });

  it('keeps visible assistant output and active thinking as boundaries, including tool dispatch messages', () => {
    const dispatch = { ...message('dispatch'), toolCalls: [{ id: 'call', name: 'bash', arguments: {}, disposition: 'Allow' as const }] };
    for (const boundary of [dispatch, { ...dispatch, content: '', isThinking: true, reasoningContent: 'thinking' },
      { ...dispatch, content: '', isLoading: true }]) {
      expect(ids(buildMessageRows([tool('a'), boundary, tool('b')], defaults).rows)).toEqual(['a', 'dispatch', 'b']);
    }
    const hiddenThinking = { ...dispatch, content: '', isThinking: true, reasoningContent: 'thinking' };
    expect(buildMessageRows([tool('a'), hiddenThinking, tool('b')], {
      ...defaults, hideThinkingDisplay: true,
    }).rows).toHaveLength(1);
  });
});
