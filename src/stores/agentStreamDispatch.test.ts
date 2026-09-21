/**
 * agentStreamManager 的事件分流：终态事件必须走对处理器。
 *
 * 后端取消路径发的是 `{type:'cancelled'}`，模型自然结束发的是 `{type:'done'}`。
 * 两者若走同一个处理器，取消就会被当成「自然结束」——在飞的工具卡片被删、回合
 * 收尾状态写成 completed（→ 过程被折叠吞掉）。这里钉住分流本身：事件名写错、
 * 分支漏加都会落到「unknown event type」的兜底分支（什么都不做，界面停在半路）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { listenCallbacks, handlers } = vi.hoisted(() => ({
  listenCallbacks: [] as Array<(event: { payload: unknown }) => void>,
  handlers: {
    handleToolResult: vi.fn(),
    handleToolCallStart: vi.fn(),
    handleTextDelta: vi.fn(),
    handleThinkingDelta: vi.fn(),
    handleDone: vi.fn(),
    handleCancelled: vi.fn(),
    handleError: vi.fn(),
    handleRetrying: vi.fn(),
    handleToolOutput: vi.fn(),
    handleToolCallDelta: vi.fn(),
    handleModelApprovalStart: vi.fn(),
    handleModelApprovalDone: vi.fn(),
    cleanupStreamState: vi.fn(),
  },
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, cb: (event: { payload: unknown }) => void) => {
    listenCallbacks.push(cb);
    return vi.fn();
  }),
}));

vi.mock('@/stores/agentStreamHandlers', () => handlers);

import { attachStreamListener } from '@/stores/agentStreamManager';

const taskId = 'task-terminal';
const convId = 'conv-terminal';

async function attachFresh(): Promise<(event: { payload: unknown }) => void> {
  listenCallbacks.length = 0;
  await attachStreamListener(taskId, convId, 'loading-1');
  expect(listenCallbacks).toHaveLength(1);
  return listenCallbacks[0];
}

describe('agentStreamManager 终态事件分流', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cancelled 事件 → handleCancelled（不是 handleDone）', async () => {
    const onEvent = await attachFresh();

    onEvent({ payload: { type: 'cancelled' } });

    expect(handlers.handleCancelled).toHaveBeenCalledWith(
      expect.anything(),
      taskId,
      convId,
      'loading-1',
    );
    expect(handlers.handleDone).not.toHaveBeenCalled();
  });

  it('done 事件 → handleDone（不是 handleCancelled）', async () => {
    const onEvent = await attachFresh();

    onEvent({ payload: { type: 'done' } });

    expect(handlers.handleDone).toHaveBeenCalledWith(
      expect.anything(),
      taskId,
      convId,
      'loading-1',
    );
    expect(handlers.handleCancelled).not.toHaveBeenCalled();
  });
});
