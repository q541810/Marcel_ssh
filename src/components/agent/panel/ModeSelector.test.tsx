// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AGENT_MODES } from '@/lib/constants';
import type { AgentMode } from '@/lib/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { ModeSelector } from './ModeSelector';

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

async function render(mode: AgentMode, setMode: (m: AgentMode) => void) {
  await act(async () => {
    root.render(<ModeSelector mode={mode} setMode={setMode} />);
  });
  return container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!;
}

describe('ModeSelector（原 AgentPanel 内联模式切换器，行为不变）', () => {
  it('关闭态：按钮显示当前模式文案，listbox 不渲染', async () => {
    const button = await render('plan', vi.fn());
    expect(button.textContent).toContain('Plan');
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it('点击展开：三个模式都渲染，当前模式标记 aria-selected', async () => {
    const button = await render('agent', vi.fn());
    await act(async () => {
      button.click();
    });

    const listbox = container.querySelector('[role="listbox"]');
    expect(listbox).not.toBeNull();
    const options = Array.from(container.querySelectorAll('[role="option"]'));
    expect(options).toHaveLength(AGENT_MODES.length);
    const selected = options.find((o) => o.getAttribute('aria-selected') === 'true');
    expect(selected?.textContent).toContain('Agent');
  });

  it('点选模式：setMode 收到目标值，面板开始退场（不再响应 aria-expanded）', async () => {
    const setMode = vi.fn();
    const button = await render('plan', setMode);
    await act(async () => {
      button.click();
    });

    const options = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    const autoOption = options.find((o) => o.textContent?.includes('Auto'));
    expect(autoOption).toBeDefined();

    await act(async () => {
      autoOption!.click();
    });

    expect(setMode).toHaveBeenCalledWith('auto');
  });

  it('点外部关闭（mousedown 落在按钮之外）', async () => {
    const button = await render('plan', vi.fn());
    await act(async () => {
      button.click();
    });
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();

    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('按钮自身不算「点外部」：mousedown 不关闭', async () => {
    const button = await render('plan', vi.fn());
    await act(async () => {
      button.click();
    });

    await act(async () => {
      button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });
});
