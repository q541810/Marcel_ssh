// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Select from './Select';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OPTIONS = Array.from({ length: 30 }, (_, i) => ({ value: `m${i}`, label: `模型 ${i}` }));

describe('Select 悬停与滚动', () => {
  let root: Root | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = '';
  });

  it('鼠标悬停换高亮不会把列表滚回当前值（滑长列表时不被拉回去）', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    // options 每次渲染都是新数组，和真实调用方一致
    const App = () => <Select value="m0" onChange={() => {}} options={OPTIONS.map((o) => ({ ...o }))} />;
    act(() => root!.render(<App />));
    act(() => host.querySelector('button')!.click());
    // 刚打开：把当前值滚进视野，一次
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    const opts = document.querySelectorAll('[data-opt]');
    for (const i of [10, 11, 12, 13]) {
      act(() => {
        opts[i].dispatchEvent(new Event('pointerover', { bubbles: true }));
        opts[i].dispatchEvent(new PointerEvent('pointerenter'));
      });
    }
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
