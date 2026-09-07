// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentMessage } from '@/lib/types';
import { TurnFoldGroup } from './TurnFoldGroup';
import { segmentTurns } from '@/lib/agentTurnFold';
import { useTurnFoldStore } from '@/stores/turnFoldStore';

// 让 react act() 在 jsdom 下正常工作（消除 "not configured to support act" 警告）
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/externalLinks', () => ({ openExternalLink: vi.fn() }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useTurnFoldStore.setState({ expanded: {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function toolMsg(id: string, toolName = 'bash'): AgentMessage {
  return {
    id, role: 'tool', content: 'ok', timestamp: new Date().toISOString(),
    toolResult: { toolName, summary: '', result: 'ok', success: true, blocked: false, toolCallId: `${id}-call` },
  };
}

function buildFoldableSegment(toolCount = 4): ReturnType<typeof segmentTurns>[0] {
  const u: AgentMessage = { id: 'u', role: 'user', content: 'do it', timestamp: new Date().toISOString() };
  const calls: AgentMessage = {
    id: 'calls', role: 'assistant', content: '', timestamp: new Date().toISOString(),
    toolCalls: Array.from({ length: toolCount }, (_, i) => ({
      id: `c${i}`, name: 'bash', arguments: { command: 'ls' }, riskLevel: 'Moderate' as const,
    })),
  };
  const tools = Array.from({ length: toolCount }, (_, i) => toolMsg(`t${i}`));
  const answer: AgentMessage = { id: 'a', role: 'assistant', content: 'done', timestamp: new Date().toISOString() };
  return segmentTurns([u, calls, ...tools, answer])[0];
}

function mount(seg: ReturnType<typeof segmentTurns>[0], forceExpand = false) {
  act(() => {
    root.render(
      <TurnFoldGroup
        conversationId="conv"
        segment={seg}
        renderUser={() => <div data-testid="user" />}
        renderAnswer={() => <div data-testid="answer">answer</div>}
        renderExpanded={() => <div data-testid="expanded">expanded-content</div>}
        forceExpand={forceExpand}
      />,
    );
  });
}

describe('TurnFoldGroup', () => {
  it('折叠态：渲染控制行 + user + 答案，不渲染过程', () => {
    const seg = buildFoldableSegment(4);
    mount(seg);
    expect(container.textContent).toContain('已执行 4 步');
    expect(container.querySelector('[data-testid="user"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="answer"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="expanded"]')).toBeNull();
  });

  it('点击控制行 → 展开并渲染过程；再点收起', () => {
    const seg = buildFoldableSegment(4);
    mount(seg);
    expect(container.querySelector('[data-testid="expanded"]')).toBeNull();
    // 点控制行展开
    const btn = container.querySelector('button')!;
    act(() => btn.click());
    expect(container.textContent).toContain('收起过程');
    expect(container.querySelector('[data-testid="expanded"]')).not.toBeNull();
    // 再点收起
    act(() => container.querySelector('button')!.click());
    expect(container.textContent).toContain('已执行 4 步');
    expect(container.querySelector('[data-testid="expanded"]')).toBeNull();
  });

  it('forceExpand（搜索命中）→ 自动展开', () => {
    const seg = buildFoldableSegment(4);
    mount(seg, true);
    // effect 触发 expandTurn
    expect(useTurnFoldStore.getState().expanded.conv?.[seg.key]).toBe(true);
  });

  it('短回合（不可折叠）由外层处理 —— TurnFoldGroup 不渲染（防御）', () => {
    // 组件不校验 foldable，只渲染控制行；foldable=false 的段由 AgentMessageList
    // 走普通路径，不会传到这里 —— 此处只验证若误传也不崩溃。
    const u: AgentMessage = { id: 'u2', role: 'user', content: 'hi', timestamp: new Date().toISOString() };
    const a: AgentMessage = { id: 'a2', role: 'assistant', content: 'yo', timestamp: new Date().toISOString() };
    const seg = segmentTurns([u, a])[0];
    mount(seg);
    expect(container.textContent).toContain('查看过程');
    expect(container.textContent).toContain('answer');
  });
});
