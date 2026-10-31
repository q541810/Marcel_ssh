import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import AgentMessageList, { alignedWindowStart } from '@/components/agent/AgentMessageList';
import type { AgentMessage } from '@/lib/types';
// 路径芯片会带进会话 store → 终端管理器（xterm 需要浏览器环境），测试里不需要真的终端
vi.mock('@/components/terminal/TerminalInstanceManager', () => ({ terminalInstanceManager: { get: () => undefined } }));

// 注意：不能写成 `selector?.(state) ?? state` —— 选择器取到 undefined 时会被
// ?? 换成整个 state 对象，`hideThinkingDisplay` 于是变成真值，思考区整块不渲染
//（与 scrollFollow.test.tsx 同一个坑）。
vi.mock('@/stores/settingsStore', () => {
  const state = { settings: { foldCompletedTurns: false } };
  return {
    useSettingsStore: (selector?: (s: unknown) => unknown) =>
      selector ? selector(state) : state,
  };
});

vi.mock('@/lib/externalLinks', () => ({
  openExternalLink: vi.fn(),
}));

function createMockMessages(count: number): AgentMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i + 1}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `Message content ${i + 1}`,
    timestamp: new Date(Date.now() + i * 1000).toISOString(),
  }));
}

describe('alignedWindowStart', () => {
  // user 在偶数下标（0,2,4...），assistant 在奇数下标 —— 模拟真实回合。
  it('起点是 user 时保持不变', () => {
    const msgs = createMockMessages(10);
    expect(alignedWindowStart(msgs, 4)).toBe(6); // msg-7(user) 在 idx6
  });

  it('起点切在回合中间（非 user）时前移到该回合的 user', () => {
    const msgs = createMockMessages(10);
    // 取 5 条 → start=5（assistant，回合中间）→ 前移到 idx4(user)
    expect(alignedWindowStart(msgs, 5)).toBe(4);
  });

  it('消息流以非 user 开头且找不到更早 user 时保持原起点（半截兜底）', () => {
    const msgs = createMockMessages(10).slice(1); // 从 assistant 开始
    // start=0（取全部）→ 不越界返回 0
    expect(alignedWindowStart(msgs, 10)).toBe(0);
    // 9 条：idx6 是 assistant → 前移找 user 到 idx5
    expect(alignedWindowStart(msgs, 3)).toBe(5);
  });

  it('窗口覆盖全量时起点为 0', () => {
    const msgs = createMockMessages(10);
    expect(alignedWindowStart(msgs, 10)).toBe(0);
    expect(alignedWindowStart(msgs, 99)).toBe(0);
  });
});

describe('AgentMessageList Pagination & Infinite Scroll', () => {
  it('renders all messages when total count <= 50', () => {
    const messages = createMockMessages(30);
    const html = renderToStaticMarkup(
      <AgentMessageList
        messages={messages}
      />
    );

    expect(html).not.toContain('加载更早消息...');
    expect(html).toContain('Message content 1');
    expect(html).toContain('Message content 30');
  });

  it('slices to latest 50 messages when total count > 50', () => {
    const messages = createMockMessages(80);
    const html = renderToStaticMarkup(
      <AgentMessageList
        messages={messages}
      />
    );

    // 顶部出现加载更早提示
    expect(html).toContain('加载更早消息...');
    // 早期消息未在 DOM 中渲染 (msg-1 到 msg-30)
    expect(html).not.toContain('Message content 1');
    expect(html).not.toContain('Message content 30');
    // 最近 50 条已渲染 (msg-31 到 msg-80)
    expect(html).toContain('Message content 31');
    expect(html).toContain('Message content 80');
  });

  it('renders target message when highlightMessageId targets an earlier message', () => {
    const messages = createMockMessages(120);
    const html = renderToStaticMarkup(
      <AgentMessageList
        messages={messages}
        highlightMessageId="msg-10"
      />
    );

    // 含有 highlightMessageId="msg-10" 时自动扩展包含早期消息
    expect(html).toContain('Message content 10');
    expect(html).toContain('Message content 120');
  });
});

describe('思考中不自动展开历史工具卡片', () => {
  const TOOL_OUTPUT = 'MARKER_TOOL_OUTPUT_9f2c';
  const THINKING_TEXT = 'MARKER_THINKING_9f2c';

  // 一个回合：user → 工具结果 → 正在思考的 assistant。
  // 卡片按 msg.id 挂载、展开态只取挂载初值，所以"切进正在思考的会话"必然
  // 让全部卡片重新挂载——曾经的整列表级 isThinking 就是在这条路径上把每张
  // 卡都初始化成展开的。
  const turnMessages = (thinking: boolean): AgentMessage[] => [
    { id: 'u1', role: 'user', content: '跑一下', timestamp: '2026-01-01T00:00:00Z' },
    {
      id: 't1',
      role: 'tool',
      content: '',
      timestamp: '2026-01-01T00:00:01Z',
      toolResult: {
        toolName: 'execute_command',
        summary: 'ls',
        result: TOOL_OUTPUT,
        success: true,
        blocked: false,
        arguments: { command: 'ls' },
      },
    },
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      reasoningContent: THINKING_TEXT,
      isThinking: thinking,
      timestamp: '2026-01-01T00:00:02Z',
    },
  ];

  it('卡片保持收起，正在流的思考内容照旧显示', () => {
    const html = renderToStaticMarkup(
      <AgentMessageList messages={turnMessages(true)} />,
    );

    // 卡片本身在（不是整块没渲染），但输出区没有展开
    expect(html).toContain('data-message-id="t1"');
    expect(html).not.toContain(TOOL_OUTPUT);
    // 取消自动展开不影响实时性：思考内容仍然直接可见
    expect(html).toContain(THINKING_TEXT);
  });

  it('思考与否展开态一致（不再取决于会话是否有人在思考）', () => {
    const thinking = renderToStaticMarkup(
      <AgentMessageList messages={turnMessages(true)} />,
    );
    const idle = renderToStaticMarkup(
      <AgentMessageList messages={turnMessages(false)} />,
    );

    expect(thinking).not.toContain(TOOL_OUTPUT);
    expect(idle).not.toContain(TOOL_OUTPUT);
  });
});
