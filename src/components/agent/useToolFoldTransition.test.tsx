// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@/lib/types';
import { buildMessageRows, type MessageRow } from './agentMessageRows';
import { collectToolExits, TOOL_FOLD_DURATION, useToolFoldTransition } from './useToolFoldTransition';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const tool = (id: string, executing = false): AgentMessage => ({
  id, role: 'tool', content: '', timestamp: '', isExecuting: executing,
  toolResult: { toolCallId: id, toolName: 'bash', success: true, summary: '', result: '', blocked: false },
});
const row = (message: AgentMessage): MessageRow => ({ key: `message:${message.id}`, kind: 'message', message });
const group = (messages: AgentMessage[], open = false): MessageRow => ({
  key: 'group:tools:a', kind: 'group', group: 'tools', messages, open,
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('tool fold transitions', () => {
  function harness(initial: MessageRow[], mountedKeys?: ReadonlySet<string>) {
    const container = document.createElement('div');
    const root = createRoot(container);
    let result!: ReturnType<typeof useToolFoldTransition>;
    function Probe({ rows }: { rows: MessageRow[] }) {
      result = useToolFoldTransition(rows, mountedKeys);
      return null;
    }
    const render = (rows: MessageRow[]) => act(() => root.render(<Probe rows={rows} />));
    render(initial);
    return { render, get result() { return result; }, unmount: () => act(() => root.unmount()) };
  }

  it('retains only absorbed cards at their existing size/content during the exit', () => {
    const completed = tool('a');
    const exits = collectToolExits([row(tool('a', true)), row(tool('deleted'))], [group([completed])]);
    expect(exits).toHaveLength(1);
    expect(exits[0].row).toEqual(row(tool('a', true)));
    expect(collectToolExits([row(completed)], [group([completed], true), row(completed)])).toEqual([]);
    expect(collectToolExits([row(tool('a', true))], [group([tool('a', true)])])).toEqual([]);
  });

  it('finishes independently during rapid updates and cancels on expansion', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    const root = createRoot(container);
    let complete: (key: string) => void = () => {};
    function Probe({ rows }: { rows: MessageRow[] }) {
      const result = useToolFoldTransition(rows);
      complete = result.onExitComplete;
      return <>{result.rows.map((entry) => <div key={entry.key} data-exit={result.exiting.has(entry.key)}>{entry.key}</div>)}</>;
    }
    act(() => root.render(<Probe rows={[row(tool('a', true)), row(tool('b', true))]} />));
    act(() => root.render(<Probe rows={[group([tool('a')]), row(tool('b', true))]} />));
    expect(container.querySelectorAll('[data-exit="true"]')).toHaveLength(1);
    act(() => vi.advanceTimersByTime(100));
    act(() => root.render(<Probe rows={[group([tool('a'), tool('b')])]} />));
    expect(container.querySelectorAll('[data-exit="true"]')).toHaveLength(2);
    act(() => vi.advanceTimersByTime(TOOL_FOLD_DURATION - 100));
    expect(container.querySelectorAll('[data-exit="true"]')).toHaveLength(2);
    act(() => complete('message:a'));
    expect(container.querySelectorAll('[data-exit="true"]')).toHaveLength(1);
    act(() => root.render(<Probe rows={[group([tool('a'), tool('b')], true), row(tool('a')), row(tool('b'))]} />));
    expect(container.querySelectorAll('[data-exit="true"]')).toHaveLength(0);
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reduced motion folds immediately', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const container = document.createElement('div');
    const root = createRoot(container);
    function Probe({ rows }: { rows: MessageRow[] }) {
      return <>{useToolFoldTransition(rows).rows.map((entry) => entry.key).join(',')}</>;
    }
    act(() => root.render(<Probe rows={[row(tool('a', true))]} />));
    act(() => root.render(<Probe rows={[group([tool('a')])]} />));
    expect(container.textContent).toBe('group:tools:a');
    act(() => root.unmount());
  });

  it('preserves chronological placement around a still executing sibling while other tools fold', () => {
    const a = tool('a');
    const busy = tool('busy', true);
    const c = tool('c');
    const summary = group([a, c], true);
    const h = harness([summary, row(a), row(busy), row(c)]);
    try {
      h.render([group([a, c]), row(busy)]);
      expect(h.result.rows.map((entry) => entry.key)).toEqual([
        'group:tools:a', 'message:a', 'message:busy', 'message:c',
      ]);
      expect([...h.result.exiting]).toEqual(['message:a', 'message:c']);
      expect(h.result.exiting.has('message:busy')).toBe(false);
      act(() => h.result.onExitComplete('message:a'));
      expect(h.result.rows.map((entry) => entry.key)).toEqual(['group:tools:a', 'message:busy', 'message:c']);
    } finally { h.unmount(); }
  });

  it('animates assistant messages and the nested tool summary when the whole turn closes and opens', () => {
    const messages: AgentMessage[] = [
      { id: 'user', role: 'user', content: 'run', timestamp: '', turnState: 'completed' },
      { id: 'progress', role: 'assistant', content: 'Checking the files', timestamp: '' },
      tool('a'), tool('b'), tool('c'),
      { id: 'answer', role: 'assistant', content: 'Done', timestamp: '' },
    ];
    const options = { foldTurns: true, tailActive: false, expandedTurns: {}, expandedGroups: new Set<string>(), matchedIds: new Set<string>() };
    const closed = buildMessageRows(messages, options).rows;
    const turn = closed.find((entry) => entry.kind === 'turn');
    expect(turn?.kind).toBe('turn');
    if (!turn || turn.kind !== 'turn') throw new Error('Expected a foldable completed turn');
    const open = buildMessageRows(messages, { ...options, expandedTurns: { [turn.segment.key]: true } }).rows;
    const h = harness(open);
    try {
      h.render(closed);
      expect([...h.result.exiting]).toEqual(['message:progress', 'group:tools:a']);
      expect(h.result.rows.map((entry) => entry.key)).toEqual(open.map((entry) => entry.key));
      act(() => { for (const key of h.result.exiting) h.result.onExitComplete(key); });
      expect(h.result.rows).toEqual(closed);
      h.render(open);
      expect([...h.result.entering]).toEqual(['message:progress', 'group:tools:a']);
      expect(h.result.exiting.size).toBe(0);
      act(() => { for (const key of h.result.entering) h.result.onEnterComplete(key); });
      expect(h.result.entering.size).toBe(0);
    } finally { h.unmount(); }
  });

  it('does not mount offscreen history merely to play an exit animation', () => {
    const a = tool('a');
    const b = tool('b');
    const h = harness([row(a), row(b)], new Set(['message:b']));
    try {
      h.render([group([a, b])]);
      expect([...h.result.exiting]).toEqual(['message:b']);
      expect(h.result.rows.map((entry) => entry.key)).toEqual(['group:tools:a', 'message:b']);
    } finally { h.unmount(); }
  });

  it('drops deleted or rolled-back rows immediately and cancels an already pending exit', () => {
    const a = tool('a');
    const deleted = tool('deleted');
    const h = harness([row(a), row(deleted)]);
    try {
      h.render([group([a])]);
      expect([...h.result.exiting]).toEqual(['message:a']);
      expect(h.result.rows.some((entry) => entry.key === 'message:deleted')).toBe(false);
      h.render([]);
      expect(h.result.rows).toEqual([]);
      expect(h.result.exiting.size).toBe(0);
      act(() => h.result.onExitComplete('message:a'));
      expect(h.result.rows).toEqual([]);
    } finally { h.unmount(); }
  });
});
