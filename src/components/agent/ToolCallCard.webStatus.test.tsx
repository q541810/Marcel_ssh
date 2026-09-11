// @vitest-environment jsdom
/**
 * ToolCallCard 里联网工具（web_search / http_get）状态标记的渲染测试。
 *
 * 背景：这两个工具的结果过去只渲染正文 pre，后端 metadata 里"用的哪个后端、
 * 有没有降级、页面是否被人机验证拦下"一点都没显示，用户只能看到空正文，于是
 * 只能反馈"网页获取失败"。本测试锁定：
 *  - 后端标识与「已降级」「被网站拦截」标记出现在**卡片标题行**（不展开可见）；
 *  - 展开后能看到解释性说明（含具体原因/供应商名）；
 *  - 旧会话（metadata 无新字段）不显示任何标记——"兼容旧数据 = 保持原样"；
 *  - 「已降级」与策略层面的「已阻止」措辞不冲突。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentMessage } from '@/lib/types';
import ToolCallCard from '@/components/agent/ToolCallCard';

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector?: (s: unknown) => unknown) =>
    selector?.({ settings: {} }) ?? { settings: {} },
}));

vi.mock('@/stores/conversationStore', () => ({
  useConversationStore: (selector?: (s: unknown) => unknown) => {
    const state = { openSubConversation: vi.fn() };
    return selector?.(state) ?? state;
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom 没有 ResizeObserver，而卡片用它测量宽度（多机标签截断用）。
// 提供一个最小桩：只要求"能构造、能 observe/disconnect"，测量值不是本测试关注点。
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

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

function renderCard(toolResult: AgentMessage['toolResult'], isExecuting = false) {
  const message: AgentMessage = {
    id: 'm1',
    role: 'tool',
    content: '',
    timestamp: '2026-01-01T00:00:00Z',
    isExecuting,
    toolResult,
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<ToolCallCard message={message} />);
  });
  return container;
}

/** 展开卡片（点击标题行按钮）。 */
function expand(el: HTMLElement) {
  const button = el.querySelector('button');
  expect(button).not.toBeNull();
  act(() => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function baseResult(overrides: Partial<NonNullable<AgentMessage['toolResult']>> = {}) {
  return {
    toolName: 'web_search',
    summary: "web_search 'x' (1 results via browser)",
    result: '## Query: x\n\n1. **T**',
    success: true,
    blocked: false,
    arguments: { query: 'x' },
    ...overrides,
  } as NonNullable<AgentMessage['toolResult']>;
}

describe('ToolCallCard 联网工具状态标记', () => {
  it('always shows which backend served the request', () => {
    const el = renderCard(
      baseResult({
        toolName: 'http_get',
        metadata: { provider: 'browser', requested_mode: 'browser' },
      }),
    );
    expect(el.textContent).toContain('本机浏览器');
    // 正常情况不应出现降级/拦截措辞
    expect(el.textContent).not.toContain('已降级');
    expect(el.textContent).not.toContain('被网站拦截');
  });

  it('shows a 已降级 chip in the header as soon as a fallback happened', () => {
    const el = renderCard(
      baseResult({
        toolName: 'web_search',
        summary: "web_search 'x' (2 results via html) [browser failed, fell back to html: boot timed out]",
        metadata: {
          provider: 'html',
          requested_mode: 'browser',
          fallback: { from: 'browser', to: 'html', reason: 'browser boot: CDP endpoint did not become ready within 12s' },
        },
      }),
    );

    const text = el.textContent ?? '';
    // 实际服务本次请求的后端 + 降级标记都必须出现在不展开就能看到的位置。
    expect(text).toContain('已降级');
    expect(text).toContain('裸抓 HTML');
    // 标题行不得把浏览器标成本次后端（只有在解释"哪个后端失败了"时才可提到它）。
    const chipTitles = Array.from(el.querySelectorAll('span[title]')).map((s) =>
      s.getAttribute('title') ?? '',
    );
    expect(chipTitles.join(' | ')).toContain('实际使用：裸抓 HTML');
  });

  it('explains the fallback and its cause without needing to expand', () => {
    const el = renderCard(
      baseResult({
        toolName: 'web_search',
        metadata: {
          provider: 'html',
          requested_mode: 'browser',
          fallback: { from: 'browser', to: 'html', reason: 'browser boot: CDP endpoint did not become ready within 12s' },
        },
      }),
    );

    // 降级属于"这次结果不一定可信"的信号，必须默认可见，不能藏在展开区里。
    const text = el.textContent ?? '';
    expect(text).toContain('已降级为裸抓 HTML');
    expect(text).toContain('本机浏览器本次没有成功');
    expect(text).toContain('CDP endpoint did not become ready');

    expand(el);
    expect(el.textContent).toContain('已降级为裸抓 HTML');
  });

  it('flags a search intercepted by a verification page', () => {
    const el = renderCard(
      baseResult({
        summary: "web_search '绝区零' blocked via browser",
        success: false,
        result:
          '## Query: 绝区零\n\n⚠ the engine returned a bot-verification page (百度安全验证) instead of results',
        metadata: {
          provider: 'browser',
          requested_mode: 'browser',
          interception: { kind: 'challenge', vendor: '百度安全验证' },
        },
      }),
    );

    expect(el.textContent).toContain('被网站拦截');

    // 被拦截属于"结果无效"，解释默认可见。
    const text = el.textContent ?? '';
    expect(text).toContain('人机验证页');
    expect(text).toContain('百度安全验证');
    expect(text).toContain('联网搜索方式');
  });

  it('names the blocked pages of a batch fetch', () => {
    const el = renderCard(
      baseResult({
        toolName: 'http_get',
        success: false,
        metadata: {
          provider: 'browser',
          requested_mode: 'browser',
          pages: [
            { url: 'https://ok.example/', status: 200, http_error: false, blank_content: false },
            { url: 'https://blocked.example/', status: null, challenge: '百度安全验证' },
          ],
        },
      }),
    );

    expect(el.textContent).toContain('1 个页面被网站拦截');

    const text = el.textContent ?? '';
    expect(text).toContain('https://blocked.example/');
    expect(text).toContain('百度安全验证');
  });

  it('warns when every page loaded but produced no readable content', () => {
    const el = renderCard(
      baseResult({
        toolName: 'http_get',
        metadata: {
          provider: 'browser',
          requested_mode: 'browser',
          pages: [{ url: 'https://empty.example/', status: 200, blank_content: true, http_error: false }],
        },
      }),
    );

    expect(el.textContent).toContain('页面没有可读内容');
  });

  it('renders legacy results unchanged (no invented status)', () => {
    // 旧会话：metadata 里没有任何新字段 → 不显示任何标记，也不报错。
    const el = renderCard(
      baseResult({
        toolName: 'web_search',
        metadata: { total_results: 3, success: 1 },
      }),
    );
    const text = el.textContent ?? '';
    expect(text).toContain('web_search');
    expect(text).not.toContain('已降级');
    expect(text).not.toContain('被网站拦截');
    expect(text).not.toContain('本机浏览器');
  });

  it('renders without metadata at all', () => {
    const el = renderCard(baseResult({ metadata: undefined }));
    expect(el.textContent).toContain('web_search');
  });

  it('leaves non-web tools untouched', () => {
    const el = renderCard(
      baseResult({
        toolName: 'bash',
        summary: 'ls',
        metadata: { provider: 'browser', requested_mode: 'html' },
      }),
    );
    const text = el.textContent ?? '';
    expect(text).not.toContain('已降级');
    expect(text).not.toContain('本机浏览器');
  });

  it('does not collide with the policy-level 已阻止 wording', () => {
    const el = renderCard(
      baseResult({
        blocked: true,
        toolName: 'web_search',
        metadata: {
          provider: 'browser',
          requested_mode: 'browser',
          interception: { kind: 'challenge', vendor: 'Cloudflare' },
        },
      }),
    );
    const text = el.textContent ?? '';
    expect(text).toContain('已阻止'); // 策略阻止
    expect(text).toContain('被网站拦截'); // 站点风控
  });
});
