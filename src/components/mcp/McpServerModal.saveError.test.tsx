// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import McpServerModal from '@/components/mcp/McpServerModal';
import type { McpServer } from '@/lib/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const SERVER: McpServer = {
  id: 'm1',
  name: 'demo',
  url: 'https://mcp.example.com/mcp',
  headers: {},
  enabled: true,
  trusted: false,
  createdAt: '',
  updatedAt: '',
};

/**
 * 保存失败时的错误文案。
 *
 * onSave 来自 mcpStore 的 addServer / updateServer：它把错误经 getErrorMessage 落进
 * store 后**原样 rethrow** —— Tauri 命令失败时抛的是结构化 `{ kind, message, data? }`
 * 对象，不是 Error。这里原来是 `err instanceof Error ? err.message : String(err)`，
 * 于是弹窗里出现 "[object Object]"（项目铁律：一律走 lib/errors 的 getErrorMessage）。
 */
describe('保存失败的错误文案', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    // Modal 用 createPortal 挂到 body，卸载后清掉残留容器
    document.body.innerHTML = '';
  });

  async function renderAndSave(onSave: (input: unknown) => Promise<void>) {
    await act(async () => {
      root.render(
        <McpServerModal open server={SERVER} onClose={vi.fn()} onSave={onSave} />,
      );
    });
    const save = Array.from(document.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('保存'),
    );
    if (!save) throw new Error('找不到「保存」按钮');
    await act(async () => {
      save.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it('结构化 AppError 取 message，不是 [object Object]', async () => {
    const onSave = vi.fn().mockRejectedValue({ kind: 'Other', message: 'URL 不可达' });

    await renderAndSave(onSave);

    expect(document.body.textContent).toContain('URL 不可达');
    expect(document.body.textContent).not.toContain('[object Object]');
  });

  it('普通 Error 仍取 message', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('连接超时'));

    await renderAndSave(onSave);

    expect(document.body.textContent).toContain('连接超时');
  });
});
