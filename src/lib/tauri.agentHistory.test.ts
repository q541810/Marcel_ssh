import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentCompactConversation, agentStartTask } from './tauri';
import type { HistorySnapshot } from './historySnapshot';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const snapshot: HistorySnapshot = {
  entries: [{ kind: 'transient', message: { role: 'user', content: '本轮原文', imagePaths: ['conversation/image.webp'] } }],
};

describe('Agent历史快照IPC', () => {
  beforeEach(() => vi.clearAllMocks());

  it('任务入口只发送原始快照，保留模型、来源与附件展示元数据', async () => {
    invoke.mockResolvedValue('task');
    const userInput = { version: 1 as const, text: '本轮原文', textAttachments: [] };
    expect(await agentStartTask('session', '本轮原文', 'agent', 'conversation', snapshot, 'task', 'model', undefined, userInput)).toBe('task');
    expect(invoke).toHaveBeenCalledWith('agent_start_task', {
      sessionId: 'session', prompt: '本轮原文', mode: 'agent', conversationId: 'conversation',
      historySnapshot: snapshot, taskId: 'task', modelId: 'model', origin: null, userInput,
    });
    expect(invoke.mock.calls[0][1]).not.toHaveProperty('history');
  });

  it('作业唤醒仍保留原来的来源标记和缺省字段', async () => {
    await agentStartTask('session', '结算告知', 'auto', 'conversation', snapshot, 'task', null, 'job_notice');
    expect(invoke.mock.calls[0][1]).toMatchObject({ origin: 'job_notice', modelId: null, userInput: null });
  });

  it('手动压缩使用相同快照契约与已有事件通道id', async () => {
    await agentCompactConversation('conversation', snapshot, 'compact-task');
    expect(invoke).toHaveBeenCalledWith('agent_compact_conversation', {
      conversationId: 'conversation', taskId: 'compact-task', historySnapshot: snapshot,
    });
  });
});
