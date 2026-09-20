// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { findScrollParent, useLongPressDrag, type LongPressDragApi } from './useLongPressDrag';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 点击抑制：拖拽期间与松手后的合成 click 都必须被吞掉。
 *
 * 回归：抑制窗口原本固定在「激活 +1000ms」。长按 320ms 才激活、再拖一阵的拖拽
 * 会拖过这个窗口 —— 松手触发的合成 click 落到卡片 onClick 上，表现为**误触发起
 * 连接**（这正是我们改的原因）。
 */
describe('useLongPressDrag 的点击抑制', () => {
  let container: HTMLDivElement;
  let root: Root;
  let api: LongPressDragApi;
  let host: HTMLButtonElement;
  let cardA: HTMLButtonElement;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    cardA = document.createElement('button');
    host = document.createElement('button');
    cardA.appendChild(host);
    cardA.style.height = '40px';
    document.body.appendChild(cardA);

    function Harness() {
      api = useLongPressDrag({ orderedIds: ['a'], onCommit: () => {} });
      return null;
    }
    act(() => root.render(<Harness />));
    // 让 hook 认得那张卡片：registerItem 需要真实元素
    act(() => {
      api.registerItem('a')(cardA);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    cardA.remove();
    container.remove();
    vi.useRealTimers();
  });

  /** 激活一次拖拽（fake timers 推过长按等待），再在 fake 时间里等它"拖一阵"。 */
  function activateDrag() {
    const touch = { touches: [{ clientY: 100 }], target: host } as unknown as React.TouchEvent;
    act(() => {
      api.onTouchStart('a')(touch);
      vi.advanceTimersByTime(400); // 320ms 长按等待 + 余量 → activate() 跑完
    });
  }

  it('拖拽结束后 350ms 内仍然吞 click（长拖拽不再提前解禁）', () => {
    activateDrag();
    vi.advanceTimersByTime(1000); // 已经拖过了旧的 1000ms 窗口

    act(() => {
      window.dispatchEvent(new Event('touchend'));
    });

    // 刚松手这一下就是合成 click 来的时候 —— 旧实现这时已经放行。
    expect(api.shouldSuppressClick()).toBe(true);
    vi.advanceTimersByTime(400);
    expect(api.shouldSuppressClick()).toBe(false);
  });
});

describe('findScrollParent', () => {
  /**
   * jsdom 不做布局，所以 scrollHeight/clientHeight 是 stub 出来的 —— 钉的是
   * 「向上找第一个真正能滚动的祖先」这段遍历逻辑本身。
   */
  function makeScrollable(el: HTMLElement, scrollable: boolean) {
    Object.defineProperty(el, 'scrollHeight', { value: scrollable ? 1000 : 200, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true });
  }

  it('优先返回最近的可滚动祖先，跳过不可滚动的', () => {
    const outer = document.createElement('div');
    const inner = document.createElement('div');
    const child = document.createElement('div');
    outer.appendChild(inner);
    inner.appendChild(child);
    document.body.appendChild(outer);

    inner.style.overflowY = 'auto';
    makeScrollable(inner, true);
    outer.style.overflowY = 'auto';
    makeScrollable(outer, true);

    try {
      expect(findScrollParent(child)).toBe(inner); // 最近的可滚动祖先
    } finally {
      outer.remove();
    }
  });

  it('overflow: hidden 但 scrollHeight 撑大时不算可滚动，继续向上找', () => {
    const outer = document.createElement('div');
    const clip = document.createElement('div');
    const child = document.createElement('div');
    outer.appendChild(clip);
    clip.appendChild(child);
    document.body.appendChild(outer);

    clip.style.overflowY = 'hidden';
    makeScrollable(clip, true); // 内容被撑大但不给滚
    outer.style.overflowY = 'scroll';
    makeScrollable(outer, true);

    try {
      expect(findScrollParent(child)).toBe(outer);
    } finally {
      outer.remove();
    }
  });

  it('一路都没有可滚动祖先时返回 null（回退到窗口坐标系）', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    try {
      expect(findScrollParent(el)).toBeNull();
    } finally {
      el.remove();
    }
  });
});
