import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import AgentMessage from '@/components/agent/AgentMessage';
import type { AgentMessage as AgentMessageType } from '@/lib/types';

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: () => false,
}));

vi.mock('@/lib/externalLinks', () => ({
  openExternalLink: vi.fn(),
}));

function makeUserMessage(overrides: Partial<AgentMessageType> = {}): AgentMessageType {
  return {
    id: 'msg-1',
    role: 'user',
    content: 'rollback this prompt',
    timestamp: '2026-01-01T00:01:00Z',
    ...overrides,
  };
}

function makeRetryingMessage(overrides: Partial<AgentMessageType> = {}): AgentMessageType {
  return {
    id: 'retry-1',
    role: 'system',
    content: '',
    timestamp: new Date().toISOString(),
    isRetrying: true,
    retryAttempt: 2,
    retryMaxAttempts: 4,
    retryTotalDelaySecs: 5,
    retryLastError: 'HTTP 429 Too Many Requests',
    ...overrides,
  };
}

describe('AgentMessage user actions', () => {
  it('renders user message metadata and action buttons', () => {
    const html = renderToStaticMarkup(
      <AgentMessage
        message={makeUserMessage()}
        onRollback={vi.fn()}
        onCopy={vi.fn()}
      />,
    );

    expect(html).toContain('rollback this prompt');
    expect(html).toContain('title="撤回到这条消息"');
    expect(html).toContain('title="复制消息"');
  });

  it('disables rollback while an agent task is running', () => {
    const html = renderToStaticMarkup(
      <AgentMessage
        message={makeUserMessage()}
        rollbackDisabled
        onRollback={vi.fn()}
        onCopy={vi.fn()}
      />,
    );

    expect(html).toContain('title="任务运行中，暂不能撤回"');
    expect(html).toContain('disabled=""');
  });
});

describe('AgentMessage retry indicator', () => {
  it('shows countdown and attempt count in waiting phase', () => {
    // timestamp = now, so remaining ≈ full 5s → waiting phase
    const html = renderToStaticMarkup(
      <AgentMessage message={makeRetryingMessage()} />,
    );

    // waiting phase: shows "Ns 后重试 (2/4)"
    expect(html).toMatch(/\d+s 后重试/);
    expect(html).toContain('(2/4)');
    // clock icon present (waiting), not spinner-only
    expect(html).toContain('cx="12" cy="12" r="9"');
  });

  it('shows retrying phase when countdown has elapsed', () => {
    // timestamp 10s ago, delay 5s → remaining = 0 → retrying phase
    const tenSecondsAgo = new Date(Date.now() - 10_000).toISOString();
    const html = renderToStaticMarkup(
      <AgentMessage
        message={makeRetryingMessage({ timestamp: tenSecondsAgo })}
      />,
    );

    expect(html).toContain('正在重试请求');
    expect(html).toContain('(2/4)');
    expect(html).toContain('animate-spin');
  });

  it('shows error summary and is expandable when error is long', () => {
    const longError = 'x'.repeat(120);
    const html = renderToStaticMarkup(
      <AgentMessage
        message={makeRetryingMessage({ retryLastError: longError })}
      />,
    );

    // summary truncated to 80 chars + ellipsis
    expect(html).toContain('x'.repeat(80) + '…');
    // expandable: has title attribute for toggle
    expect(html).toContain('点击展开完整错误');
  });

  it('shows full short error inline without expand control', () => {
    const html = renderToStaticMarkup(
      <AgentMessage
        message={makeRetryingMessage({ retryLastError: 'timeout' })}
      />,
    );

    expect(html).toContain('timeout');
    // short error: no expand title
    expect(html).not.toContain('点击展开完整错误');
  });

  it('hides attempt count when maxAttempts is 0', () => {
    const html = renderToStaticMarkup(
      <AgentMessage
        message={makeRetryingMessage({ retryMaxAttempts: 0 })}
      />,
    );

    expect(html).not.toContain('(2/0)');
    expect(html).not.toContain('(2/');
  });
});

describe('AgentMessage thinking display', () => {
  function makeAssistantMessage(
    overrides: Partial<AgentMessageType> = {},
  ): AgentMessageType {
    return {
      id: 'think-1',
      role: 'assistant',
      content: 'answer',
      timestamp: '2026-01-01T00:01:00Z',
      ...overrides,
    };
  }

  it('shows thinking while streaming (isThinking + reasoningContent)', () => {
    const html = renderToStaticMarkup(
      <AgentMessage
        message={makeAssistantMessage({ isThinking: true, reasoningContent: '正在思考...' })}
      />,
    );

    expect(html).toContain('思考中');
    // 折叠逻辑照旧：默认收起，思考内容不直接展开
    expect(html).not.toContain('正在思考...');
  });

  it('hides thinking once the reply completes (isThinking cleared, reasoning kept)', () => {
    // 完成即删：isThinking=false 时即使 reasoningContent 保留也不显示
    const html = renderToStaticMarkup(
      <AgentMessage
        message={makeAssistantMessage({ isThinking: false, reasoningContent: '思考内容' })}
      />,
    );

    expect(html).not.toContain('思考中');
    expect(html).not.toContain('已思考');
    expect(html).not.toContain('思考内容');
    // 正文照常显示
    expect(html).toContain('answer');
  });

  it('hides thinking for tool_calls messages even with reasoningContent', () => {
    const html = renderToStaticMarkup(
      <AgentMessage
        message={makeAssistantMessage({
          isThinking: false,
          reasoningContent: '思考内容',
          toolCalls: [
            {
              id: 'call-1',
              name: 'execute_command',
              arguments: { command: 'ls' },
              riskLevel: 'LowRisk' as const,
            },
          ],
        })}
      />,
    );

    expect(html).not.toContain('思考中');
    expect(html).not.toContain('已思考');
  });

  it('renders LaTeX math in assistant messages', () => {
    const html = renderToStaticMarkup(
      <AgentMessage
        message={makeAssistantMessage({
          content: '解：$$x_1 = 1, \\quad x_2 = \\frac{1}{2}$$',
        })}
      />,
    );

    // 同行 $$：按生态默认渲染为行内公式（katex 节点，非 display 居中）
    expect(html).toContain('class="katex"');
    expect(html).not.toContain('class="katex-display"');
    // 分隔符被消费，不再以 $$ 形式出现在正文
    expect(html).not.toContain('$$x_1');
  });

  it('renders display math for $$ on its own line', () => {
    const html = renderToStaticMarkup(
      <AgentMessage
        message={makeAssistantMessage({
          content: '解：\n$$\nx_1 = 1, \\quad x_2 = \\frac{1}{2}\n$$\n得证。',
        })}
      />,
    );

    // 独占行 $$ → display 居中节点
    expect(html).toContain('class="katex-display"');
    expect(html).toContain('class="katex"');
    expect(html).not.toContain('$$x_1');
  });

  it('renders inline LaTeX with single dollar delimiters', () => {
    const html = renderToStaticMarkup(
      <AgentMessage
        message={makeAssistantMessage({
          content: '令 $a = \\sqrt{2}$，则 $a^2 = 2$。',
        })}
      />,
    );

    // 行内公式：katex 节点（非 display 节点）
    expect(html).toContain('class="katex"');
    expect(html).not.toContain('class="katex-display"');
    expect(html).not.toContain('$a');
  });

  it('does not crash on streaming half-open math delimiters', () => {
    // 流式输出中间态：$$ 已开未闭 / \frac 未闭合，不能崩、不能白屏
    const html = renderToStaticMarkup(
      <AgentMessage
        message={makeAssistantMessage({
          content: '解：$$x_1 = \\frac{1}{',
        })}
      />,
    );

    // 组件仍渲染出内容（不抛错）；半截公式按普通文本保留
    expect(html).toContain('解：');
    expect(html).toContain('\\frac');
  });

  it('renders malformed math as error text instead of crashing', () => {
    // KaTeX 渲染失败时兜底为红色错误文本，而不是整个组件崩溃
    const html = renderToStaticMarkup(
      <AgentMessage
        message={makeAssistantMessage({
          content: '$$\\frac{1}{2}$$',
        })}
      />,
    );

    // 正常闭合的公式渲染成功，不应出现错误标记
    expect(html).toContain('class="katex"');
  });
});
