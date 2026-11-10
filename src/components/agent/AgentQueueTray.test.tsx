// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/tauri', () => ({ agentDeleteMessageImage: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/stores/conversationStore', () => ({
  conversationIsBusy: () => false,
  useConversationStore: { getState: () => ({}), subscribe: () => () => {} },
}));
vi.mock('@/stores/taskStore', () => ({
  useTaskStore: { getState: () => ({}), subscribe: () => () => {} },
}));

import AgentQueueTray from './AgentQueueTray';
import { useAgentQueueStore } from '@/stores/agentQueueStore';
import { draftKeyFor, resetAgentDrafts, useAgentDraftStore } from '@/stores/agentDraftStore';

const CONV = 'c1';
let container: HTMLDivElement;
let root: Root;

function enqueue(text: string) {
  useAgentQueueStore.getState().enqueue({
    conversationId: CONV,
    sessionId: 's1',
    draft: {
      text,
      images: [],
      textAttachments: [],
      skills: [],
      userInput: { version: 1, text, textAttachments: [] },
    },
  });
}

async function render(props: Partial<React.ComponentProps<typeof AgentQueueTray>> = {}) {
  await act(async () => {
    root.render(<AgentQueueTray conversationId={CONV} {...props} />);
  });
}

beforeEach(() => {
  useAgentQueueStore.setState({ items: {}, paused: {} });
  resetAgentDrafts();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('AgentQueueTray', () => {
  it('队列为空不渲染任何东西', async () => {
    await render();
    expect(container.innerHTML).toBe('');
  });

  it('按顺序列出排队消息，并说明何时发送', async () => {
    enqueue('先做这个');
    enqueue('再做那个');
    await render();
    const rows = container.querySelectorAll('li');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('先做这个');
    expect(rows[1].textContent).toContain('再做那个');
    expect(container.textContent).toContain('待发送 2 条');
    expect(container.textContent).toContain('当前任务完成后依次发出');
  });

  it('移除按钮删掉对应一条', async () => {
    enqueue('甲');
    enqueue('乙');
    await render();
    await act(async () => {
      (container.querySelector('[aria-label="移除第 1 条"]') as HTMLButtonElement).click();
    });
    expect(useAgentQueueStore.getState().items[CONV].map((m) => m.draft.text)).toEqual(['乙']);
  });

  it('取回按钮把内容放回输入草稿并通知宿主聚焦', async () => {
    enqueue('要改的话');
    const onPulledBack = vi.fn();
    await render({ onPulledBack });
    await act(async () => {
      (container.querySelector('[aria-label="取回第 1 条到输入框编辑"]') as HTMLButtonElement).click();
    });
    expect(onPulledBack).toHaveBeenCalledTimes(1);
    expect(useAgentDraftStore.getState().getDraft(draftKeyFor(CONV, null)).text).toBe('要改的话');
    expect(useAgentQueueStore.getState().items[CONV]).toBeUndefined();
  });

  it('暂停时显示原因，并提供「继续发送」与「清空」', async () => {
    enqueue('排着的');
    useAgentQueueStore.setState({ paused: { [CONV]: { kind: 'stopped' } } });
    await render();
    expect(container.textContent).toContain('排队的消息已暂停');
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toContain('继续发送');
    expect(buttons).toContain('清空');

    await act(async () => {
      Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '清空')!.click();
    });
    expect(useAgentQueueStore.getState().items[CONV]).toBeUndefined();
    expect(useAgentQueueStore.getState().paused[CONV]).toBeUndefined();
  });

  it('仅附件/仅 skill 的消息也有可读的摘要', async () => {
    useAgentQueueStore.getState().enqueue({
      conversationId: CONV,
      sessionId: 's1',
      draft: {
        text: '',
        images: [],
        textAttachments: [{ id: 'a', name: 'log.txt', content: 'x' }],
        skills: [],
        userInput: { version: 1, text: '', textAttachments: [{ id: 'a', name: 'log.txt', content: 'x' }] },
      },
    });
    await render();
    expect(container.textContent).toContain('log.txt');
  });
});
