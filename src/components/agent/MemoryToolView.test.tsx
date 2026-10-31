import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentMessage } from '@/lib/types';

vi.mock('@/stores/memoryStore', () => {
  const state = { batches: {}, loadBatch: vi.fn(), revertOp: vi.fn(), loadOverview: vi.fn(), overview: null };
  const useMemoryStore = (sel: (s: typeof state) => unknown) => sel(state);
  useMemoryStore.getState = () => state;
  return { useMemoryStore };
});
vi.mock('@/components/memory/MemoryEditDialog', () => ({ default: () => null }));

import MemoryToolView from './MemoryToolView';
// 路径芯片会带进会话 store → 终端管理器（xterm 需要浏览器环境），测试里不需要真的终端
vi.mock('@/components/terminal/TerminalInstanceManager', () => ({ terminalInstanceManager: { get: () => undefined } }));

const item = {
  id: 'm1', title: '重启前先停 nginx', content: '部署脚本会自己拉起，手动重启会冲突', version: 1,
} as never;

const message = {
  id: 'msg1',
  role: 'tool',
  content: '',
  toolResult: {
    toolName: 'memory',
    success: true,
    result: 'ok',
    metadata: { memory: { op: 'add', opId: 7, batchId: 'b1', memoryId: 'm1', scopeLabel: '机器「web-01」', before: null, after: item } },
  },
} as unknown as AgentMessage;

describe('MemoryToolView', () => {
  it('用工具卡的骨架显示：已记住 + 标题 + 作用域；收起时不带正文和撤销/编辑', () => {
    const html = renderToStaticMarkup(<MemoryToolView message={message} />);
    expect(html).toContain('已记住');
    expect(html).toContain('重启前先停 nginx');
    expect(html).toContain('机器「web-01」');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('部署脚本会自己拉起');
    expect(html).not.toContain('撤销');
  });

  it('在展开的分组里与通用工具卡一样缩进', () => {
    expect(renderToStaticMarkup(<MemoryToolView message={message} grouped />)).toContain('pl-3');
    expect(renderToStaticMarkup(<MemoryToolView message={message} />)).not.toContain('pl-3');
  });
});
