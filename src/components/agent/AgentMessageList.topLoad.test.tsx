// @vitest-environment jsdom
/**
 * 顶部哨兵自动续载的死锁回归测试。
 *
 * 背景：AgentMessageList 向上翻页靠顶部哨兵的 IntersectionObserver crossing
 * 触发（每批 +PAGE_SIZE=50）。但当新加载的一批消息全是已完成回合折叠出的矮行
 * 时，滚动锚定后哨兵仍停在容器顶部 rootMargin 检测带内——IO 不会再有 crossing
 * → “加载更早消息...” 永久空转、怎么等都不加载。
 *
 * 修复：每次布局后复查哨兵是否仍停在检测带内，是则 rAF 续载下一批，直到被顶出
 * 或没有更早消息可载（布局兜底，不依赖 IO crossing）。
 *
 * 本测试在 jsdom 中渲染真实组件：
 *  - 场景一：哨兵停在检测带内（默认零几何）→ 不触发任何 IO crossing，消息窗口
 *    也会自动一路扩展到最老消息，哨兵随加载完毕消失。
 *  - 场景二：哨兵位于检测带外（模拟被顶出/未停驻）→ 布局兜底不得越权加载，
 *    仍只有 IO crossing 能驱动翻页（保持原行为）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import AgentMessageList from '@/components/agent/AgentMessageList';

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector?: (s: unknown) => unknown) =>
    selector?.({ settings: { foldCompletedTurns: false } }) ?? { settings: { foldCompletedTurns: false } },
}));

vi.mock('@/lib/externalLinks', () => ({
  openExternalLink: vi.fn(),
}));

// React 18 需要显式声明 act 环境，否则 jsdom 下渲染/状态冲刷会告警
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── jsdom 缺失的浏览器 API 桩 ─────────────────────────────────────────────

type IOEntry = { isIntersecting: boolean };

class IntersectionObserverStub {
  static instances: IntersectionObserverStub[] = [];
  callback: (entries: IOEntry[]) => void;
  fired = 0;

  constructor(callback: (entries: IOEntry[]) => void) {
    this.callback = callback;
    IntersectionObserverStub.instances.push(this);
  }

  observe() {}
  unobserve() {}
  disconnect() {}

  /** 模拟一次 crossing（含可见/不可见两种） */
  fire(entry: IOEntry) {
    this.fired += 1;
    this.callback([entry]);
  }
}

function stubBrowserApis(sentinelTop: number) {
  vi.stubGlobal('IntersectionObserver', IntersectionObserverStub);
  // jsdom 默认无 rAF：用 setTimeout 兜底，配合 act 内的真实时间片冲刷
  vi.stubGlobal(
    'requestAnimationFrame',
    (cb: FrameRequestCallback) => window.setTimeout(() => cb(Date.now()), 0),
  );
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  // 几何控制：默认全 0（哨兵恰在容器顶部检测带内）；需要“已顶出”场景时
  // 让哨兵 wrapper（text-xs 的那层）的 top 远在容器上方。
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(
    this: Element,
  ): DOMRect {
    const el = this as HTMLElement;
    const isSentinelWrapper =
      el.classList?.contains('text-xs') &&
      (el.textContent ?? '').includes('加载更早消息');
    const top = isSentinelWrapper ? sentinelTop : 0;
    return {
      x: 0,
      y: top,
      top,
      bottom: top,
      left: 0,
      right: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
}

function createMockMessages(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i + 1}`,
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `Message content ${i + 1}`,
    timestamp: new Date(Date.now() + i * 1000).toISOString(),
  }));
}

// ── 渲染与冲刷工具 ────────────────────────────────────────────────────────

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function mountList(messageCount: number) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <AgentMessageList messages={createMockMessages(messageCount)} isThinking={false} />,
    );
  });
  return host;
}

/** 让每个 rAF（setTimeout）都有机会触发并冲刷 React 状态与布局副作用 */
async function flushFrames(times = 12) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

function text() {
  return host?.textContent ?? '';
}

/** 消息是否已渲染进 DOM：按 data-message-id 精确定位，避免
 *  “Message content 151” 误包含 “Message content 1” 这类子串误判。 */
function hasMsg(id: string) {
  return host?.querySelector(`[data-message-id="${id}"]`) !== null;
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  host?.remove();
  host = null;
  root = null;
  IntersectionObserverStub.instances = [];
  vi.unstubAllGlobals();
});

// ── 测试 ──────────────────────────────────────────────────────────────────

describe('AgentMessageList 顶部哨兵自动续载', () => {
  it('哨兵停在检测带内：不触发 IO crossing 也会自动一路加载到最老消息', async () => {
    stubBrowserApis(0); // 哨兵与容器同为 0 → 停在检测带内
    await mountList(200);

    // 初始只渲染尾部 50 条：最老消息不可见，哨兵可见
    expect(hasMsg('msg-151')).toBe(true);
    expect(text()).toContain('加载更早消息...');
    expect(hasMsg('msg-1')).toBe(false);

    await flushFrames();

    // 布局兜底自动续载到全部 200 条，期间没有任何 IO crossing
    expect(hasMsg('msg-1')).toBe(true);
    expect(hasMsg('msg-200')).toBe(true);
    expect(text()).not.toContain('加载更早消息...');
    expect(
      IntersectionObserverStub.instances.reduce((sum, io) => sum + io.fired, 0),
    ).toBe(0);
  });

  it('哨兵被顶出检测带：布局兜底不越权加载，翻页仍由 IO crossing 驱动', async () => {
    stubBrowserApis(-10000); // 哨兵远在容器上方 → 不在检测带内
    await mountList(200);

    // 初始尾部 50 条
    expect(hasMsg('msg-151')).toBe(true);
    expect(hasMsg('msg-1')).toBe(false);

    await flushFrames();

    // 停驻检测带外 → 布局兜底不得自行加载：最老消息仍然不可见
    expect(hasMsg('msg-1')).toBe(false);
    expect(hasMsg('msg-151')).toBe(true);

    // 模拟用户滚到顶：IO crossing 触发一批（+50）
    await act(async () => {
      IntersectionObserverStub.instances[0]?.fire({ isIntersecting: true });
    });
    await flushFrames();

    // 只加载了一批：窗口推进到 100 条，最老消息仍未渲染；再多等也不自动续
    expect(hasMsg('msg-101')).toBe(true);
    expect(hasMsg('msg-1')).toBe(false);
  });
});
