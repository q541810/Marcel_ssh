// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CHAT_CONTENT_WIDTH_KEY } from '@/lib/chatContentWidth';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import ContentWidthHandles from './ContentWidthHandles';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.removeItem(CHAT_CONTENT_WIDTH_KEY);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.removeItem(CHAT_CONTENT_WIDTH_KEY);
});

describe('宽度把手（拖拽对称 2×、仅实际位移提交、双击复位）', () => {
  // jsdom lacks pointer capture: emulate per-element so hasPointerCapture
  // gates pass（与 DSH skeleton.client.spec 同一手法），finally 还原防泄漏。
  function stubPointerCapture(): () => void {
    const names = ['setPointerCapture', 'releasePointerCapture', 'hasPointerCapture'] as const;
    const originals = names.map(
      (name) => [name, Object.getOwnPropertyDescriptor(Element.prototype, name)] as const,
    );
    const captured = new Set<Element>();
    Element.prototype.setPointerCapture = function () {
      captured.add(this);
    };
    Element.prototype.releasePointerCapture = function () {
      captured.delete(this);
    };
    Element.prototype.hasPointerCapture = function () {
      return captured.has(this);
    };
    return () => {
      for (const [name, descriptor] of originals) {
        if (descriptor === undefined) Reflect.deleteProperty(Element.prototype, name);
        else Object.defineProperty(Element.prototype, name, descriptor);
      }
    };
  }

  type HandleCallbacks = Parameters<typeof ContentWidthHandles>[0];
  function setup(overrides: Partial<HandleCallbacks> = {}) {
    const callbacks = {
      onStart: vi.fn(() => 920),
      onDrag: vi.fn(),
      onCommit: vi.fn(),
      onEnd: vi.fn(),
      onReset: vi.fn(),
    };
    Object.assign(callbacks, overrides);
    act(() => {
      root.render(<ContentWidthHandles {...callbacks} />);
    });
    return {
      callbacks,
      handle: (side: 'left' | 'right') =>
        container.querySelector<HTMLElement>(`.agent-width-handle[data-side='${side}']`)!,
    };
  }

  function fire(
    el: HTMLElement,
    type: 'pointerdown' | 'pointerup' | 'pointercancel' | 'dblclick',
    clientX = 800,
  ) {
    act(() => {
      if (type === 'dblclick') el.dispatchEvent(new Event('dblclick', { bubbles: true }));
      else
        el.dispatchEvent(
          new PointerEvent(type, { bubbles: true, pointerId: 1, clientX, clientY: 300 }),
        );
    });
  }

  it('左右各渲染一个把手', () => {
    const { handle } = setup();
    expect(handle('left')).not.toBeNull();
    expect(handle('right')).not.toBeNull();
    // cursor: col-resize / 定位由 globals.css 的 .agent-width-handle 提供（jsdom 不加载外部样式表）。
  });

  it('右把手向外拖 25px → 提交 base+50；无位移的按压不提交', () => {
    const { callbacks, handle } = setup();
    const restore = stubPointerCapture();
    try {
      const right = handle('right');
      fire(right, 'pointerdown', 800);
      fire(right, 'pointerup', 825);
      expect(callbacks.onCommit).toHaveBeenCalledWith(970); // 920 + 25×2
      expect(callbacks.onEnd).toHaveBeenCalled();

      const commitsBefore = callbacks.onCommit.mock.calls.length;
      fire(right, 'pointerdown', 800);
      fire(right, 'pointerup', 800); // 无位移
      expect(callbacks.onCommit.mock.calls.length).toBe(commitsBefore);
    } finally {
      restore();
    }
  });

  it('左把手的向外方向相反：向左拖 25px 同样是 +50', () => {
    const { callbacks, handle } = setup();
    const restore = stubPointerCapture();
    try {
      const left = handle('left');
      fire(left, 'pointerdown', 800);
      fire(left, 'pointerup', 775);
      expect(callbacks.onCommit).toHaveBeenCalledWith(970);
    } finally {
      restore();
    }
  });

  it('pointercancel：手势放弃不提交，onEnd 照常（辉光状态可复位）', () => {
    const { callbacks, handle } = setup();
    const restore = stubPointerCapture();
    try {
      const right = handle('right');
      fire(right, 'pointerdown', 800);
      fire(right, 'pointercancel', 850);
      expect(callbacks.onCommit).not.toHaveBeenCalled();
      expect(callbacks.onEnd).toHaveBeenCalled();
      expect(right.hasAttribute('data-dragging')).toBe(false);
    } finally {
      restore();
    }
  });

  it('双击复位：触发 onReset（清偏好回到自适应）', () => {
    const { callbacks, handle } = setup();
    fire(handle('right'), 'dblclick');
    expect(callbacks.onReset).toHaveBeenCalledTimes(1);
  });
});
