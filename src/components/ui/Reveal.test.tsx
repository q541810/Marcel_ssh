// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { Simulate } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import Reveal from '@/components/ui/Reveal';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

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

const wrapper = () => container.querySelector('.transient-reveal') as HTMLElement;
const render = (show: boolean) =>
  act(() => root.render(<Reveal show={show}><span>内容</span></Reveal>));
// jsdom 里 React 监听的是带前缀的事件名，手动 dispatchEvent 触达不到：用 Simulate 直接触发。
const animationEnd = (el: HTMLElement) => act(() => { Simulate.animationEnd(el); });

describe('Reveal 的裁切', () => {
  it('一开始就显示：没有进场动画，直接放开裁切（里面的下拉菜单不被截断）', () => {
    render(true);
    expect(wrapper().className).toContain('transient-reveal-settled');
    expect(wrapper().className).not.toContain('transient-reveal-enter');
  });

  it('后来才显示：进场动画期间要裁（高度从 0 长出来），播完才放开', () => {
    render(false);
    render(true);
    expect(wrapper().className).toContain('transient-reveal-enter');
    expect(wrapper().className).not.toContain('transient-reveal-settled');
    animationEnd(wrapper());
    expect(wrapper().className).toContain('transient-reveal-settled');
  });

  it('子元素（如下拉菜单自己的入场动画）冒泡上来的动画结束不算', () => {
    render(false);
    render(true);
    animationEnd(wrapper().querySelector('span') as HTMLElement);
    expect(wrapper().className).not.toContain('transient-reveal-settled');
  });

  it('animationend 没来也会兜底放开（减少动态效果 / 不可见祖先）', () => {
    vi.useFakeTimers();
    try {
      render(false);
      render(true);
      expect(wrapper().className).not.toContain('transient-reveal-settled');
      act(() => { vi.advanceTimersByTime(500); });
      expect(wrapper().className).toContain('transient-reveal-settled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('收起时立刻恢复裁切', () => {
    render(true);
    render(false);
    expect(wrapper().className).toContain('transient-reveal-exit');
    expect(wrapper().className).not.toContain('transient-reveal-settled');
  });
});
