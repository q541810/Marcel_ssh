// @vitest-environment jsdom
/**
 * ToolCallCard 上审批判定元信息的渲染测试。
 *
 * 锁定的三件事：
 *  1. Jev 引擎判定时卡片标出「Jev 判定」——用户要知道自己在依赖谁；
 *  2. 置信度按「分布集中度」措辞，**不写成「可信度/准确率」**——官方对 Jev
 *     `confidence` 的定义是概率分布的集中程度，不是判定正确的概率。措辞写错
 *     会让用户以为自己看到了准确率，这是会误导决策的；
 *  3. 老会话（没有 engine/confidence）不显示任何标注——"兼容旧数据 = 保持原样"。
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

function renderCard(modelApproval: AgentMessage['modelApproval']) {
  const message: AgentMessage = {
    id: 'm1',
    role: 'tool',
    content: '',
    timestamp: '2026-01-01T00:00:00Z',
    modelApproval,
    toolResult: {
      toolName: 'bash',
      summary: '$ rm -rf build',
      result: '',
      success: true,
      blocked: false,
      arguments: { command: 'rm -rf build' },
    },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<ToolCallCard message={message} />);
  });
  return container;
}

describe('ToolCallCard 审批判定元信息', () => {
  it('Jev 判定时标出引擎名与分布集中度', () => {
    const el = renderCard({
      status: 'done',
      decision: 'route_to_human',
      reasons: ['会删除或覆盖数据'],
      engine: 'jev',
      confidence: 0.62,
    });
    const text = el.textContent ?? '';
    expect(text).toContain('Jev 判定');
    expect(text).toContain('分布集中度 62%');
    // 理由标签（后端给的中文常量）照常展示。
    expect(text).toContain('会删除或覆盖数据');
  });

  it('措辞不得把置信度说成可信度或正确率', () => {
    const el = renderCard({
      status: 'done',
      decision: 'block',
      reasons: ['影响不可撤销'],
      engine: 'jev',
      confidence: 0.87,
    });
    const text = el.textContent ?? '';
    // 可见文案里只能出现「分布集中度」，不得出现把概率说成准确性的词。
    expect(text).toContain('分布集中度');
    for (const wrong of ['可信度', '准确率', '正确率']) {
      expect(text, `不得用「${wrong}」描述 Jev 的 confidence`).not.toContain(wrong);
    }
    // 悬停说明把事情讲清楚。
    const titled = el.querySelector('[title]');
    expect(titled?.getAttribute('title')).toContain('不是判定正确的概率');
  });

  it('会话模型引擎不标 Jev，也不显示分布集中度', () => {
    const el = renderCard({
      status: 'done',
      decision: 'route_to_human',
      reasons: ['与用户诉求无关'],
      engine: 'model',
    });
    const text = el.textContent ?? '';
    expect(text).not.toContain('Jev 判定');
    expect(text).not.toContain('分布集中度');
    expect(text).toContain('与用户诉求无关');
  });

  it('旧数据（既无 engine 也无 confidence）不渲染任何标注行', () => {
    const el = renderCard({
      status: 'done',
      decision: 'block',
      reasons: ['危险'],
    });
    const text = el.textContent ?? '';
    expect(text).not.toContain('Jev 判定');
    expect(text).not.toContain('分布集中度');
    // 原有内容不受影响——兼容旧数据 = 保持原样。
    expect(text).toContain('模型阻止');
    expect(text).toContain('危险');
  });

  it('approve 不显示审批标记（与既有行为一致）', () => {
    const el = renderCard({
      status: 'done',
      decision: 'approve',
      reasons: [],
      engine: 'jev',
      confidence: 0.99,
    });
    const text = el.textContent ?? '';
    expect(text).not.toContain('Jev 判定');
    expect(text).not.toContain('分布集中度');
  });
});
