// @vitest-environment jsdom
/**
 * 子agent 卡片上的「思考 x」芯片。
 *
 * 三件事必须钉住：
 *  1. 主 agent 传了 `reasoning_effort` → 卡片上要看得见（否则用户不知道这一发
 *     是按哪个档位跑的）；
 *  2. 没传 → 一个芯片都不出现（子agent 走模型自身默认，界面不该暗示有档位）；
 *  3. 结果回来后以 `metadata.reasoningEffort` 为准 —— 后端按**真实落地模型**的
 *     声明判过、确实发进请求体的那个值；被拒的档位不在 metadata 里，所以卡片
 *     不会显示一个没生效的值。
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
    const state = { openSubConversation: vi.fn(), activeConversationBySession: {} };
    return selector?.(state) ?? state;
  },
}));
vi.mock('@/lib/fileNav', () => ({
  runFileAction: vi.fn(async () => {}),
  runDefaultFileAction: vi.fn(async () => {}),
  copyWithNotice: vi.fn(async () => {}),
  canShowFileManager: () => true,
  isMobileShell: () => false,
  boundSessionOf: () => null,
  findProjectRoot: async () => null,
  getRemoteHome: async () => null,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function render(el: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(el));
  return container;
}

/** 流式中的工具调用卡（还没有结果）。 */
function streamingMessage(toolName: string, args: Record<string, unknown>): AgentMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    timestamp: '2026-01-01T00:00:00Z',
    isExecuting: true,
    toolCall: { id: 'c1', name: toolName, arguments: args },
  } as unknown as AgentMessage;
}

/** 已完成的工具结果卡。 */
function doneMessage(
  toolName: string,
  args: Record<string, unknown>,
  metadata?: Record<string, unknown>,
): AgentMessage {
  return {
    id: 'm2',
    role: 'tool',
    content: '',
    timestamp: '2026-01-01T00:00:00Z',
    toolResult: { toolName, success: true, result: '调研结论', arguments: args, metadata },
  } as unknown as AgentMessage;
}

const effortChips = (el: HTMLElement) =>
  Array.from(el.querySelectorAll('*')).filter(
    (n) => n.children.length === 0 && /^思考 /.test(n.textContent ?? ''),
  );

describe('子agent 卡片：思考强度芯片', () => {
  it('传了 reasoning_effort：发起瞬间就显示（流式卡）', () => {
    const el = render(
      <ToolCallCard
        message={streamingMessage('subagent', { prompt: 'p', reasoning_effort: 'high' })}
      />,
    );
    expect(effortChips(el).map((n) => n.textContent)).toEqual(['思考 high']);
  });

  it('传了 reasoning_effort：结果卡的 metadata 接管后仍显示', () => {
    const el = render(
      <ToolCallCard
        message={doneMessage('subagent', { prompt: 'p', reasoning_effort: 'low' }, {
          status: 'completed',
          reasoningEffort: 'high',
        })}
      />,
    );
    // metadata 是权威值：显示实际生效的 high，而不是参数里的 low。
    expect(effortChips(el).map((n) => n.textContent)).toEqual(['思考 high']);
  });

  it('档位被拒（metadata 无 reasoningEffort）：只按参数，不凭空造一个生效值', () => {
    const el = render(
      <ToolCallCard
        message={doneMessage('subagent', { prompt: 'p', reasoning_effort: 'ultra' }, {
          status: 'completed',
        })}
      />,
    );
    // 发起时的参数仍然可见（用户能看出主 agent 要过这个档位），
    // 但后端没确认它生效 —— 结果卡不会把这当成既定事实另外标注。
    expect(effortChips(el).map((n) => n.textContent)).toEqual(['思考 ultra']);
  });

  it('没传：一个思考芯片都不出现', () => {
    const el = render(<ToolCallCard message={doneMessage('subagent', { prompt: 'p' })} />);
    expect(effortChips(el)).toEqual([]);
  });

  it('非 subagent 工具即使参数里有同名键也不显示（读取按工具名收口）', () => {
    const el = render(
      <ToolCallCard
        message={doneMessage('bash', { command: 'ls', reasoning_effort: 'high' })}
      />,
    );
    expect(effortChips(el)).toEqual([]);
  });
});
