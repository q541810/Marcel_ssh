// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import SplitHandle from './SplitHandle';

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

interface Handlers {
  onNudge: ReturnType<typeof vi.fn>;
  onReset: ReturnType<typeof vi.fn>;
  onPointerDown: ReturnType<typeof vi.fn>;
}

function render(props: { growDirection?: 1 | -1; draggable?: boolean } = {}): { el: HTMLElement; handlers: Handlers } {
  const handlers: Handlers = { onNudge: vi.fn(), onReset: vi.fn(), onPointerDown: vi.fn() };
  act(() => {
    root.render(
      <SplitHandle
        label="调整侧边栏宽度"
        value={280}
        min={220}
        max={560}
        active={false}
        draggable={props.draggable ?? true}
        growDirection={props.growDirection ?? 1}
        onPointerDown={handlers.onPointerDown}
        onPointerMove={() => {}}
        onPointerUp={() => {}}
        onPointerCancel={() => {}}
        onNudge={handlers.onNudge}
        onReset={handlers.onReset}
      />,
    );
  });
  return { el: container.firstElementChild as HTMLElement, handlers };
}

const press = (el: HTMLElement, key: string, shiftKey = false) => {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
  });
};

describe('SplitHandle', () => {
  it('暴露分隔条语义与当前宽度，命中区比可见条更宽', () => {
    const { el } = render();

    expect(el.getAttribute('role')).toBe('separator');
    expect(el.getAttribute('aria-orientation')).toBe('vertical');
    expect(el.getAttribute('aria-label')).toBe('调整侧边栏宽度');
    expect(el.getAttribute('aria-valuenow')).toBe('280');
    expect(el.getAttribute('aria-valuemin')).toBe('220');
    expect(el.getAttribute('aria-valuemax')).toBe('560');
    expect(el.getAttribute('tabindex')).toBe('0');
    // 可见 4px，命中区靠隐形子元素向两侧各扩 4px
    expect(el.className).toContain('w-1');
    expect((el.firstElementChild as HTMLElement).className).toContain('-left-1');
    expect((el.firstElementChild as HTMLElement).className).toContain('-right-1');
  });

  it('方向键按把手所在边给出正确的加宽方向', () => {
    const left = render({ growDirection: 1 }); // 把手在面板右缘：右方向键变宽
    press(left.el, 'ArrowRight');
    expect(left.handlers.onNudge).toHaveBeenLastCalledWith(16);
    press(left.el, 'ArrowLeft');
    expect(left.handlers.onNudge).toHaveBeenLastCalledWith(-16);

    const right = render({ growDirection: -1 }); // 把手在面板左缘：左方向键变宽
    press(right.el, 'ArrowLeft');
    expect(right.handlers.onNudge).toHaveBeenLastCalledWith(16);
    press(right.el, 'ArrowRight');
    expect(right.handlers.onNudge).toHaveBeenLastCalledWith(-16);
  });

  it('Shift + 方向键走大步长，其他按键不触发', () => {
    const { el, handlers } = render();
    press(el, 'ArrowRight', true);
    expect(handlers.onNudge).toHaveBeenLastCalledWith(64);
    press(el, 'ArrowDown');
    press(el, 'a');
    expect(handlers.onNudge).toHaveBeenCalledTimes(1);
  });

  it('双击复位', () => {
    const { el, handlers } = render();
    act(() => {
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(handlers.onReset).toHaveBeenCalledTimes(1);
  });

  it('没有可调空间时不提示可拖动', () => {
    expect(render({ draggable: true }).el.className).toContain('cursor-col-resize');
    const fixed = render({ draggable: false }).el.className;
    expect(fixed).toContain('cursor-default');
    expect(fixed).not.toContain('cursor-col-resize');
  });
});
