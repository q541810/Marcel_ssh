import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupStreamState, handleCancelled, handleDone, handleError, handleToolCallStart,
  handleToolOutput, handleToolResult,
} from './agentStreamHandlers';
import { mockHandler } from './streamHandlerMock';

const task = 'output-batch';
const conversation = 'output-conversation';
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
const flush = () => {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach((callback) => callback(0));
};
beforeEach(() => {
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
afterEach(() => {
  cleanupStreamState(task);
  vi.unstubAllGlobals();
});
function setup() {
  const handler = mockHandler({ [conversation]: [] });
  for (const id of ['a', 'b']) {
    handleToolCallStart(handler, task, conversation, { type: 'toolCallStart', id, name: 'bash' });
  }
  return handler;
}
describe('tool output frame batching', () => {
  it('publishes a burst once, retaining parallel tool ordering', () => {
    const handler = setup();
    const update = vi.spyOn(handler, 'updateMessages');
    for (let i = 0; i < 100; i++) {
      handleToolOutput(handler, task, conversation, 'a', `${i},`);
      handleToolOutput(handler, task, conversation, 'b', 'b');
    }
    expect(update).not.toHaveBeenCalled();
    flush();
    expect(update).toHaveBeenCalledTimes(1);
    expect(handler._messages[conversation][0].toolResult?.result).toBe(
      Array.from({ length: 100 }, (_, i) => `${i},`).join(''),
    );
    expect(handler._messages[conversation][1].toolResult?.result).toBe('b'.repeat(100));
  });
  it.each(['cleanup', 'cancelled', 'failed', 'done'])('flushes before %s', (ending) => {
    const handler = setup();
    const snapshots: string[] = [];
    const originalUpdate = handler.updateMessages;
    vi.spyOn(handler, 'updateMessages').mockImplementation((id, updater) => {
      originalUpdate(id, updater);
      snapshots.push(handler._messages[id].find((m) => m.toolResult?.toolCallId === 'a')?.toolResult?.result ?? '');
    });
    handleToolOutput(handler, task, conversation, 'a', 'tail');
    if (ending === 'cleanup') cleanupStreamState(task);
    if (ending === 'cancelled') handleCancelled(handler, task, conversation, '');
    if (ending === 'failed') handleError(handler, task, conversation, '', { type: 'error', message: 'failure' });
    if (ending === 'done') handleDone(handler, task, conversation, '');
    // Done/error intentionally discard unfinished tools after the boundary flush.
    expect(snapshots).toContain('tail');
    if (ending !== 'done' && ending !== 'failed') {
      expect(handler._messages[conversation].find((m) => m.toolResult?.toolCallId === 'a')?.toolResult?.result).toBe('tail');
    }
    expect(frames.size).toBe(0);
  });
  it('settled result is authoritative and late output cannot overwrite it', () => {
    const handler = setup();
    handleToolOutput(handler, task, conversation, 'a', 'pending');
    handleToolResult(handler, task, conversation, '', {
      type: 'toolResult', arguments: {},
      toolCallId: 'a', toolName: 'bash', summary: 'done', result: 'final', success: true, blocked: false,
    });
    handleToolOutput(handler, task, conversation, 'a', 'late');
    flush();
    expect(handler._messages[conversation].find((m) => m.toolResult?.toolCallId === 'a')?.toolResult?.result).toBe('final');
  });
  it('ignores unknown and empty output without creating state updates', () => {
    const handler = setup();
    const update = vi.spyOn(handler, 'updateMessages');
    handleToolOutput(handler, task, conversation, 'unknown', 'text');
    handleToolOutput(handler, task, conversation, 'a', '');
    flush();
    expect(update).not.toHaveBeenCalled();
  });
});
