import { describe, expect, it } from 'vitest';
import fixtures from '../../src-tauri/tests/fixtures/llm_history.json';
import { createHistorySnapshot, type HistorySnapshot } from './historySnapshot';
import type { AgentMessage, StoredMessage } from './types';
import { storedMessageToAgentMessage } from '@/stores/messageConversion';

function message(fields: Partial<AgentMessage> = {}): AgentMessage {
  return { id: 'ui-message', role: 'user', content: '原文\r\n', timestamp: '2026-01-01T00:00:00Z', ...fields };
}

describe('createHistorySnapshot', () => {
  it('保留顺序、原角色、通知和骨架，投影规则交给后端', () => {
    const original = [
      message({ role: 'notice', content: '后台作业已完成' }),
      message({ role: 'system', content: '错误提示' }),
      message({ role: 'system', content: '', compaction: { status: 'done', summary: '摘要原文\n' } }),
      message({ role: 'assistant', content: '', isLoading: true }),
    ];
    expect(createHistorySnapshot(original)).toEqual({ entries: [
      { kind: 'transient', message: { role: 'notice', content: '后台作业已完成' } },
      { kind: 'transient', message: { role: 'system', content: '错误提示' } },
      { kind: 'transient', message: { role: 'system', content: '', compaction: { status: 'done', summary: '摘要原文\n' } } },
      { kind: 'transient', message: { role: 'assistant', content: '', isLoading: true } },
    ] });
  });

  it('DB引用带清除思考的明确覆盖和原始内容兜底', () => {
    expect(createHistorySnapshot([message({ dbId: 'row-1', reasoningContent: undefined })])).toEqual({ entries: [
      {
        kind: 'stored', id: 'row-1', reasoningContent: null,
        fallback: { role: 'user', content: '原文\r\n', dbId: 'row-1' },
      },
    ] });
    const retained = createHistorySnapshot([message({ dbId: 'row-2', role: 'assistant', reasoningContent: '完整思考' })]);
    expect(retained.entries[0]).toMatchObject({ kind: 'stored', reasoningContent: '完整思考', fallback: { reasoningContent: '完整思考' } });
  });

  it('快照之后修改消息或嵌套工具参数不会改掉在途输入', () => {
    const original = message({
      role: 'tool', imagePaths: ['images/one.png'],
      toolResult: { toolName: 'read_file', toolCallId: 'call-1', arguments: { paths: ['/a'] }, result: '旧结果', summary: '', success: true, blocked: false },
    });
    const snapshot = createHistorySnapshot([original]);
    original.content = '新正文';
    original.imagePaths!.push('images/two.png');
    (original.toolResult!.arguments!.paths as string[]).push('/b');
    original.toolResult!.result = '新结果';
    expect(snapshot.entries[0]).toEqual({ kind: 'transient', message: {
      role: 'tool', content: '原文\r\n', imagePaths: ['images/one.png'],
      toolResult: { toolName: 'read_file', result: '旧结果', arguments: { paths: ['/a'] }, toolCallId: 'call-1' },
    } });
  });

  it('展示元数据不进入历史快照，附件正文仍完整保留', () => {
    const original = message({
      content: '问题\n\n===== 文件名: a.log =====\n日志\r\n\r\n',
      userInput: { version: 1, text: '问题', textAttachments: [{ id: 'file', name: 'a.log', content: '日志\r\n\r\n' }] },
      isThinking: false, turnState: 'failed',
    });
    expect(createHistorySnapshot([original])).toEqual({ entries: [
      { kind: 'transient', message: { role: 'user', content: original.content } },
    ] });
  });
});

interface HistoryFixture {
  name: string;
  snapshot: HistorySnapshot;
  storedMessages: StoredMessage[];
}

describe('与 Rust 共用的历史输入夹具', () => {
  // expected 模型输出由 Rust 验证；这里钉住 UI 重载/取样交给后端的原始输入。
  it.each(fixtures as unknown as HistoryFixture[])('$name', (fixture) => {
    const rows = new Map(fixture.storedMessages.map((row) => [row.id, row]));
    const messages = fixture.snapshot.entries.map((entry, index) => {
      const row = entry.kind === 'stored' ? rows.get(entry.id) : undefined;
      if (row && entry.kind === 'stored') {
        return { ...storedMessageToAgentMessage(row), reasoningContent: entry.reasoningContent ?? undefined };
      }
      const raw = entry.kind === 'stored' ? entry.fallback : entry.message;
      return { id: `fixture-${index}`, timestamp: '', ...raw } as AgentMessage;
    });
    // 与真实 IPC 一样省略 undefined；旧损坏 tool JSON 的缺字段也保持同一形状。
    expect(JSON.parse(JSON.stringify(createHistorySnapshot(messages)))).toEqual(fixture.snapshot);
  });
});
