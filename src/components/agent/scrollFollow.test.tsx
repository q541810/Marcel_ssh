// @vitest-environment jsdom
/**
 * 内嵌滚动区「贴底跟随」的回归测试。
 *
 * 背景：思考区（max-h 40vh）、压缩摘要（max-h 44）、工具输出（max-h 120px）都是
 * 固定高度的内滚盒子，流式内容一多就装不下。过去的跟随写法是：
 *
 *     useEffect(() => {
 *       const el = ref.current;
 *       const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
 *       if (atBottom) el.scrollTop = el.scrollHeight;
 *     }, [内容]);
 *
 * 这个 effect 跑在内容**已经进 DOM**（盒子已经变高）之后，而 scrollTop 不会跟着
 * 内容一起长 —— 所以量出来的不是"用户离底部多远"，而是"这一批新增了多少"。
 * 新增不足阈值时还能追上，一旦某次超过阈值（中文一两行就够）就再也追不上，
 * 跟随**永久**停住：画面停在老内容上，用户只能自己往下拖。
 *
 * 修复：判定改由 onScroll 记下的状态给出（useStickyFollow），内容变长后照它贴底。
 * 本测试锁定三件事：
 *  1. 一次长出一大截（远超阈值）也仍然贴底 —— 这条在旧写法下必红；
 *  2. 用户上翻看历史时不被拽回；
 *  3. 用户滑回底部后恢复跟随 —— 这条在旧写法下也必红。
 *
 * jsdom 不做布局（scrollHeight/clientHeight 恒为 0），而跟随逻辑恰恰只吃这三个
 * 数，所以下面用自有属性覆盖掉它们，把"内容长了"和"用户拖走了"变成可驱动的动作。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentMessage as AgentMessageType } from '@/lib/types';
import AgentMessage from '@/components/agent/AgentMessage';
import ToolCallCard from '@/components/agent/ToolCallCard';

// 注意：不能写成 `selector?.(state) ?? state` —— 选择器取到 undefined 时会被
// ?? 换成整个 state 对象，`hideThinkingDisplay` 于是变成真值，思考区整块不渲染，
// 测试就"找不到元素"或者更糟：断言了个不存在的东西还以为通过。
vi.mock('@/stores/settingsStore', () => {
  const state = { settings: {} };
  return {
    useSettingsStore: (selector?: (s: unknown) => unknown) =>
      selector ? selector(state) : state,
  };
});

vi.mock('@/stores/conversationStore', () => ({
  useConversationStore: (selector?: (s: unknown) => unknown) => {
    const state = { openSubConversation: vi.fn() };
    return selector?.(state) ?? state;
  },
}));

vi.mock('@/lib/externalLinks', () => ({
  openExternalLink: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom 没有 ResizeObserver，ToolCallCard 用它测宽（多机标签截断用）
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

// ── 可控几何的滚动容器 ─────────────────────────────────────────────────────

interface ScrollBox {
  /** 当前滚动位置。 */
  readonly scrollTop: number;
  readonly scrollHeight: number;
  /** 内容变长（真实浏览器里 scrollTop 不会跟着变）。 */
  grow(px: number): void;
  /** 用户把滚动条拖到 top，并派发 scroll（React 的 onScroll 就挂在这个元素上）。 */
  userScrollTo(top: number): void;
  /** 用户滑到底部。 */
  userScrollToBottom(): void;
}

const CLIENT_HEIGHT = 160;

function makeScrollBox(el: HTMLElement, clientHeight = CLIENT_HEIGHT): ScrollBox {
  let scrollHeight = clientHeight;
  let scrollTop = 0;
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    get: () => clientHeight,
  });
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v;
    },
  });
  return {
    get scrollTop() {
      return scrollTop;
    },
    get scrollHeight() {
      return scrollHeight;
    },
    grow(px: number) {
      scrollHeight += px;
    },
    userScrollTo(top: number) {
      scrollTop = top;
      act(() => {
        el.dispatchEvent(new Event('scroll'));
      });
    },
    userScrollToBottom() {
      this.userScrollTo(scrollHeight - clientHeight);
    },
  };
}

/** 按 Tailwind 高度类找滚动盒子；找不到直接抛，避免"断言了个不存在的元素"式假绿。 */
function findBox(container: HTMLElement, heightClass: string, label: string): HTMLElement {
  const el = Array.from(container.querySelectorAll<HTMLElement>('div, pre')).find((n) =>
    (n.getAttribute('class') ?? '').includes(heightClass),
  );
  if (!el) throw new Error(`没渲染出${label}（找不到 ${heightClass}）`);
  return el;
}

// ── 渲染脚手架 ─────────────────────────────────────────────────────────────

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  container?.remove();
  container = null;
});

function mount(node: React.ReactElement): HTMLElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(node);
  });
  return container;
}

function rerender(node: React.ReactElement) {
  act(() => {
    root?.render(node);
  });
}

function assistantThinking(reasoningContent: string): AgentMessageType {
  return {
    id: 'think-1',
    role: 'assistant',
    content: '',
    timestamp: '2026-01-01T00:01:00Z',
    isThinking: true,
    reasoningContent,
  };
}

function systemCompaction(summary: string): AgentMessageType {
  return {
    id: 'compact-1',
    role: 'system',
    content: '',
    timestamp: '2026-01-01T00:01:00Z',
    compaction: { status: 'running', summary },
  };
}

function toolOutput(result: string, isExecuting = true): AgentMessageType {
  return {
    id: 'tool-1',
    role: 'tool',
    content: '',
    timestamp: '2026-01-01T00:01:00Z',
    isExecuting,
    toolResult: {
      toolName: 'execute_command',
      summary: 'execute_command',
      result,
      success: true,
      blocked: false,
      arguments: { command: 'cat big.log' },
    },
  };
}

const THINKING_BOX = 'max-h-[40vh]';
const COMPACTION_BOX = 'max-h-44';
const OUTPUT_BOX = 'max-h-[120px]';

describe('内嵌滚动区贴底跟随', () => {
  function thinkingScenario() {
    const el = mount(<AgentMessage autoExpand message={assistantThinking('第一段')} />);
    const box = makeScrollBox(findBox(el, THINKING_BOX, '思考区滚动容器'));
    return { el, box };
  }

  it('思考区：一次长出一大截，仍然贴着底部', () => {
    const { el, box } = thinkingScenario();
    box.grow(600);

    rerender(
      <AgentMessage autoExpand message={assistantThinking(`第一段${'第二段'.repeat(300)}`)} />,
    );

    expect(box.scrollTop).toBe(box.scrollHeight);
    expect(el.textContent).toContain('思考中');
  });

  it('思考区：用户上翻看历史时不被拽回底部', () => {
    const { el, box } = thinkingScenario();
    box.grow(600);
    box.userScrollTo(0); // 上翻到顶

    box.grow(200);
    rerender(
      <AgentMessage autoExpand message={assistantThinking(`第一段${'第二段'.repeat(300)}`)} />,
    );

    expect(box.scrollTop).toBe(0);
    expect(el.textContent).toContain('思考中');
  });

  it('思考区：滑回底部后恢复跟随', () => {
    const { el, box } = thinkingScenario();
    box.grow(600);
    box.userScrollTo(0);
    box.userScrollToBottom(); // 又滑回底部

    box.grow(200);
    rerender(
      <AgentMessage autoExpand message={assistantThinking(`第一段${'第二段'.repeat(300)}`)} />,
    );

    expect(box.scrollTop).toBe(box.scrollHeight);
    expect(el.textContent).toContain('思考中');
  });

  it('压缩摘要：实时摘要同样是贴底跟随', () => {
    const el = mount(<AgentMessage message={systemCompaction('正在总结')} />);
    const box = makeScrollBox(findBox(el, COMPACTION_BOX, '压缩摘要滚动容器'));
    box.grow(400);

    rerender(<AgentMessage message={systemCompaction(`正在总结${'小节'.repeat(200)}`)} />);

    expect(box.scrollTop).toBe(box.scrollHeight);
    expect(el.textContent).toContain('正在压缩上下文');
  });

  it('工具输出：执行中追加输出时贴底，用户上翻后不打扰', () => {
    const el = mount(<ToolCallCard message={toolOutput('line 1\n')} />);
    const box = makeScrollBox(findBox(el, OUTPUT_BOX, '工具输出滚动容器'));
    box.grow(400);

    rerender(<ToolCallCard message={toolOutput(`line 1\n${'line 2\n'.repeat(200)}`)} />);
    expect(box.scrollTop).toBe(box.scrollHeight);

    box.userScrollTo(0);
    box.grow(200);
    rerender(<ToolCallCard message={toolOutput(`line 1\n${'line 2\n'.repeat(400)}`)} />);
    expect(box.scrollTop).toBe(0);
  });
});
