// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import SegmentedControl from './SegmentedControl';

// 让 react act() 在 jsdom 下正常工作（消除 "not configured to support act" 警告）
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const OPTIONS = [
  { value: 'auto', label: '自动更新' },
  { value: 'notify', label: '仅提醒' },
  { value: 'off', label: '关闭' },
] as const;

type Mode = (typeof OPTIONS)[number]['value'];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderControl(
  value: Mode = 'auto',
  onChange: (v: Mode) => void = () => {},
  disabled = false,
) {
  act(() => {
    root.render(
      <SegmentedControl
        ariaLabel="更新方式"
        options={OPTIONS}
        value={value}
        disabled={disabled}
        onChange={onChange}
      />,
    );
  });
}

function radio(label: string): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find(
    (b) => b.textContent === label,
  );
  if (!el) throw new Error(`找不到选项：${label}`);
  return el;
}

describe('SegmentedControl', () => {
  it('exposes radio semantics so screen readers announce the selection', () => {
    renderControl('notify');
    expect(container.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe(
      '更新方式',
    );
    expect(radio('仅提醒').getAttribute('aria-checked')).toBe('true');
    expect(radio('关闭').getAttribute('aria-checked')).toBe('false');
  });

  it('reports the clicked option', () => {
    const onChange = vi.fn();
    renderControl('auto', onChange);
    act(() => radio('关闭').click());
    expect(onChange).toHaveBeenCalledWith('off');
  });

  it('moves between options with arrow keys', () => {
    const onChange = vi.fn();
    renderControl('auto', onChange);
    act(() => {
      radio('自动更新').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });
    expect(onChange).toHaveBeenCalledWith('notify');
  });

  it('wraps around at both ends', () => {
    const onChange = vi.fn();
    renderControl('off', onChange);
    act(() => {
      radio('关闭').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('auto');
  });

  it('ignores clicks and focus keys while disabled', () => {
    const onChange = vi.fn();
    renderControl('off', onChange, true);
    expect(radio('关闭').disabled).toBe(true);
    act(() => radio('自动更新').click());
    act(() => {
      radio('自动更新').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
      );
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});
