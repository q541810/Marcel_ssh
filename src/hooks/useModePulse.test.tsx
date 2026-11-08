// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMode } from '@/lib/types';
import { MODE_PULSE_MS, useModePulse } from './useModePulse';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const seen: boolean[] = [];

function Probe({ mode }: { mode: AgentMode }) {
  seen.push(useModePulse(mode));
  return null;
}
const render = (mode: AgentMode) => act(() => root.render(<Probe mode={mode} />));
const last = () => seen[seen.length - 1];

beforeEach(() => {
  vi.useFakeTimers();
  seen.length = 0;
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe('useModePulse', () => {
  it('does not flash on first mount or while the mode stays the same', () => {
    render('plan');
    render('plan');
    expect(seen.every((v) => v === false)).toBe(true);
  });

  it('flashes when the mode changes, then settles by itself', () => {
    render('plan');
    render('agent');
    expect(last()).toBe(true);
    act(() => { vi.advanceTimersByTime(MODE_PULSE_MS + 10); });
    expect(last()).toBe(false);
  });
});
