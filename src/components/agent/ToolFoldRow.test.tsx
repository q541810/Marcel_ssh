// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ToolFoldRow from './ToolFoldRow';
import { TOOL_FOLD_DURATION, useToolFoldTransition } from './useToolFoldTransition';
import type { MessageRow } from './agentMessageRows';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('ToolFoldRow animation lifecycle', () => {
  let root: Root;
  let container: HTMLDivElement;
  let height: number;
  let animations: Array<{
    frames: Keyframe[];
    animation: Animation;
    finish: () => void;
  }>;

  beforeEach(() => {
    vi.useFakeTimers();
    height = 124;
    animations = [];
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => (
      { height, width: 300, top: 0, left: 0, right: 300, bottom: height, x: 0, y: 0, toJSON() {} }
    ));
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: vi.fn((frames: Keyframe[]) => {
        let resolveFinished!: (value: Animation) => void;
        const finished = new Promise<Animation>((resolve) => { resolveFinished = resolve; });
        const animation = {
          cancel: vi.fn(), onfinish: null, finished,
          addEventListener: vi.fn((name: string, listener: EventListener) => {
            if (name === 'finish') animation.onfinish = listener;
          }),
        } as unknown as Animation;
        animations.push({ frames, animation, finish() {
          animation.onfinish?.call(animation, new Event('finish') as AnimationPlaybackEvent);
          resolveFinished(animation);
        } });
        return animation;
      }),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('notifies removal only after the actual animation finishes, even with a delayed animation clock', async () => {
    const done = vi.fn();
    act(() => root.render(<ToolFoldRow rowKey="message:a" exiting onExitComplete={done}>Tool</ToolFoldRow>));
    expect(animations).toHaveLength(1);
    act(() => vi.advanceTimersByTime(TOOL_FOLD_DURATION + 100));
    expect(done).not.toHaveBeenCalled();
    await act(async () => { animations[0].finish(); });
    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith('message:a');
    expect(animations[0].frames[animations[0].frames.length - 1]?.height).toBe('0px');
  });

  it('lays out revealed rows at natural height before fading in without moving their geometry', () => {
    act(() => root.render(<ToolFoldRow rowKey="message:a" exiting={false} entering>Tool</ToolFoldRow>));
    const row = container.firstElementChild as HTMLElement;
    expect(row.style.opacity).toBe('0');
    expect(row.style.height).toBe('');
    expect(animations).toHaveLength(0);
    act(() => vi.advanceTimersByTime(16));
    expect(animations).toHaveLength(0);
    act(() => vi.advanceTimersByTime(16));
    expect(animations).toHaveLength(1);
    expect(animations[0].frames[0].opacity).toBeDefined();
    expect(animations[0].frames[animations[0].frames.length - 1]?.opacity).toBe(1);
    for (const frame of animations[0].frames) {
      expect(frame.height).toBeUndefined();
      expect(frame.transform).toBeUndefined();
    }
  });

  it('keeps changing content at natural height when entry finishes and clears its hidden inline state', async () => {
    const done = vi.fn();
    act(() => root.render(<ToolFoldRow rowKey="message:a" exiting={false} entering onEnterComplete={done}>Tool</ToolFoldRow>));
    act(() => vi.advanceTimersByTime(32));
    const row = container.firstElementChild as HTMLElement;
    height = 248;
    act(() => root.render(<ToolFoldRow rowKey="message:a" exiting={false} entering onEnterComplete={done}>Tool with additional content</ToolFoldRow>));
    expect(row.style.height).toBe('');
    expect(animations).toHaveLength(1);
    await act(async () => { animations[0].finish(); });
    expect(row.style.height).toBe('');
    expect(row.style.opacity).toBe('');
    expect(animations[0].animation.cancel).toHaveBeenCalled();
    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith('message:a');
  });

  it.each([0, 16])('cancels pending entry frames when unmounted after %i ms', (elapsed) => {
    const done = vi.fn();
    act(() => root.render(<ToolFoldRow rowKey="message:a" exiting={false} entering onEnterComplete={done}>Tool</ToolFoldRow>));
    act(() => vi.advanceTimersByTime(elapsed));
    act(() => root.render(null));
    act(() => vi.runAllTimers());
    expect(animations).toHaveLength(0);
    expect(done).not.toHaveBeenCalled();
  });

  it('reverses a collapse with natural layout and an opacity-only entry', () => {
    act(() => root.render(<ToolFoldRow rowKey="message:a" exiting>Tool</ToolFoldRow>));
    height = 47;
    act(() => root.render(<ToolFoldRow rowKey="message:a" exiting={false} entering>Tool</ToolFoldRow>));
    expect(animations[0].animation.cancel).toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(32));
    expect(animations).toHaveLength(2);
    for (const frame of animations[1].frames) {
      expect(frame.height).toBeUndefined();
      expect(frame.transform).toBeUndefined();
    }
    expect((container.firstElementChild as HTMLElement).style.height).toBe('');
  });

  it('does not animate ordinary mounts, including virtualized remounts', () => {
    act(() => root.render(<ToolFoldRow rowKey="message:a" exiting={false}>Tool</ToolFoldRow>));
    expect(animations).toHaveLength(0);
  });

  it('keeps an exiting row in the list until its animation completes, across unrelated stream updates', async () => {
    const message: Extract<MessageRow, { kind: 'message' }>['message'] = {
      id: 'a', role: 'tool', content: '', timestamp: '',
      toolResult: { toolCallId: 'a', toolName: 'bash', success: true, summary: '', result: '', blocked: false },
    };
    const toolRow: MessageRow = { key: 'message:a', kind: 'message', message };
    const group: MessageRow = { key: 'group:tools:a', kind: 'group', group: 'tools', messages: [message], open: false };
    function Probe({ rows }: { rows: MessageRow[] }) {
      const result = useToolFoldTransition(rows);
      return <>{result.rows.map((row) => <ToolFoldRow key={row.key} rowKey={row.key}
        exiting={result.exiting.has(row.key)} entering={result.entering.has(row.key)}
        onExitComplete={result.onExitComplete}>{row.key}</ToolFoldRow>)}</>;
    }
    act(() => root.render(<Probe rows={[toolRow]} />));
    act(() => root.render(<Probe rows={[group]} />));
    const outgoing = animations.find((entry) => entry.frames[entry.frames.length - 1]?.height === '0px');
    expect(outgoing).toBeDefined();
    act(() => vi.advanceTimersByTime(TOOL_FOLD_DURATION + 100));
    act(() => root.render(<Probe rows={[{ ...group }]} />));
    expect(container.querySelector('[data-virtual-row-key="message:a"]')).not.toBeNull();
    await act(async () => { outgoing!.finish(); });
    expect(container.querySelector('[data-virtual-row-key="message:a"]')).toBeNull();
  });
});
