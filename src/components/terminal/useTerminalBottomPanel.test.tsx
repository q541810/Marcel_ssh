// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useTerminalBottomPanel } from './useTerminalBottomPanel';
import { useSettingsStore } from '@/stores/settingsStore';
import { isBottomPanelMounted, requestBottomTab } from '@/lib/bottomPanelNav';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type BottomPanel = ReturnType<typeof useTerminalBottomPanel>;

// 可控 ResizeObserver：捕获回调，用例里手动驱动「容器/窗口高度变化」。
let roCallback: ResizeObserverCallback | null = null;
(globalThis as Record<string, unknown>).ResizeObserver = class {
  constructor(cb: ResizeObserverCallback) {
    roCallback = cb;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
};

function fireContainerHeight(height: number) {
  act(() => {
    roCallback?.([{ contentRect: { height } } as ResizeObserverEntry], {} as ResizeObserver);
  });
}

function dispatchMouse(type: string, clientY: number) {
  act(() => {
    document.dispatchEvent(new MouseEvent(type, { clientY }));
  });
}

let latest: BottomPanel | null = null;

function Host() {
  latest = useTerminalBottomPanel();
  return <div ref={latest.terminalRootRef} />;
}

let container: HTMLDivElement;
let root: Root;
let updateSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  updateSpy = vi.fn(async () => {});
  useSettingsStore.setState({
    loaded: true,
    settings: { ...useSettingsStore.getState().settings, panelHeight: 256 },
    update: updateSpy,
  });

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<Host />);
  });
  // 初始容器高度 800：ratio 无存档 → panelHeight 取存档 256，ratio = 0.32
  fireContainerHeight(800);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('useTerminalBottomPanel 落库门控', () => {
  it('拖拽手势结束才把 panelHeight 落库一次', () => {
    act(() => {
      latest!.handlePanelResizeMouseDown({
        clientY: 700,
        preventDefault: () => {},
      } as Parameters<BottomPanel['handlePanelResizeMouseDown']>[0]);
    });
    dispatchMouse('mousemove', 650);
    dispatchMouse('mouseup', 650);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledWith({ panelHeight: 306 });
  });

  it('窗口 resize 的比例重算只动本地，不写设置（拖拽过一次之后也一样）', () => {
    // 先拖一次（此后旧行为会把 hasResized 永久置真）
    act(() => {
      latest!.handlePanelResizeMouseDown({
        clientY: 700,
        preventDefault: () => {},
      } as Parameters<BottomPanel['handlePanelResizeMouseDown']>[0]);
    });
    dispatchMouse('mousemove', 650);
    dispatchMouse('mouseup', 650);
    expect(updateSpy).toHaveBeenCalledTimes(1);

    // 窗口变矮：容器 800 → 600（防抖 120ms 后生效），面板按 ratio 重算
    fireContainerHeight(600);
    act(() => {
      vi.advanceTimersByTime(130);
    });

    // 重算后的高度确实变了（拖后 ratio 306/800 × 600 = 229.5 → 230），
    // 但没有再写设置
    expect(latest!.panelHeight).toBe(230);
    expect(updateSpy).toHaveBeenCalledTimes(1);

    // 连续 resize 再来一轮：仍不写
    fireContainerHeight(500);
    act(() => {
      vi.advanceTimersByTime(130);
    });
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it('只点住手柄没拖动，不产生落库', () => {
    act(() => {
      latest!.handlePanelResizeMouseDown({
        clientY: 700,
        preventDefault: () => {},
      } as Parameters<BottomPanel['handlePanelResizeMouseDown']>[0]);
    });
    dispatchMouse('mouseup', 700);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

describe('useTerminalBottomPanel 响应「请求切到某个标签」', () => {
  it('底栏收着时：展开并切到请求的标签，且登记为在场宿主', () => {
    expect(latest!.activeTab).toBeNull();
    expect(isBottomPanelMounted()).toBe(true);
    act(() => requestBottomTab('file-manager'));
    expect(latest!.activeTab).toBe('file-manager');
  });

  it('开着别的标签时切过去；请求的标签已经开着时不会把它收起来', () => {
    act(() => latest!.setActiveTab('process'));
    act(() => requestBottomTab('file-manager'));
    expect(latest!.activeTab).toBe('file-manager');
    act(() => requestBottomTab('file-manager'));
    expect(latest!.activeTab).toBe('file-manager');
  });

  it('卸载后注销宿主，不再响应', () => {
    act(() => root.unmount());
    expect(isBottomPanelMounted()).toBe(false);
    // afterEach 还会 unmount 一次：重新挂一个空壳，避免对已卸载的 root 重复操作
    root = createRoot(container);
  });
});
