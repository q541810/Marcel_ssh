// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMcpStore } from '@/stores/mcpStore';
import type { McpServer } from '@/lib/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const tauriMock = vi.hoisted(() => ({
  mcpListServers: vi.fn(),
  mcpAddServer: vi.fn(),
  mcpUpdateServer: vi.fn(),
  mcpDeleteServer: vi.fn(),
  mcpToggleServer: vi.fn(),
  mcpRefreshTools: vi.fn(),
}));

vi.mock('@/lib/tauri', () => tauriMock);

import { MobileExternalMcpSection } from './MobileExternalMcpSection';

const SERVER: McpServer = {
  id: 'server-1',
  name: '文件服务',
  url: 'https://example.com/mcp',
  headers: { Authorization: 'Bearer token' },
  enabled: true,
  trusted: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

let container: HTMLDivElement;
let root: Root;

function serverList(servers: McpServer[] = []) {
  return {
    servers,
    statuses: servers.map((server) => ({
      serverId: server.id,
      tools: [{ name: 'read_file', description: '读取文件', inputSchema: { type: 'object' } }],
      error: null,
      discovered: true,
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  tauriMock.mcpListServers.mockResolvedValue(serverList());
  tauriMock.mcpAddServer.mockImplementation(async (input) => ({
    ...SERVER,
    ...input,
    id: 'new-server',
  }));
  tauriMock.mcpUpdateServer.mockResolvedValue(undefined);
  tauriMock.mcpDeleteServer.mockResolvedValue(undefined);
  tauriMock.mcpToggleServer.mockResolvedValue(undefined);
  tauriMock.mcpRefreshTools.mockResolvedValue([]);
  useMcpStore.setState({
    servers: [],
    statuses: {},
    loading: false,
    refreshingIds: {},
    error: null,
  });
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.querySelectorAll('[role="dialog"]').forEach((el) => el.remove());
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderSection() {
  await act(async () => {
    root.render(<MobileExternalMcpSection />);
  });
  await settle();
}

function button(text: string, exact = true): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find((el) => {
    const content = el.textContent?.trim() ?? '';
    return exact ? content === text : content.includes(text);
  });
  if (!found) throw new Error(`找不到按钮：${text}`);
  return found;
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}

async function setField(id: string, value: string) {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
    throw new Error(`找不到字段：${id}`);
  }
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function dialog(): HTMLElement {
  const el = document.body.querySelector<HTMLElement>('[role="dialog"]');
  if (!el) throw new Error('没有打开的弹层');
  return el;
}

describe('手机外部 MCP 管理', () => {
  it('显示已发现工具，支持刷新、启停和编辑', async () => {
    tauriMock.mcpListServers.mockResolvedValue(serverList([SERVER]));
    await renderSection();

    expect(container.textContent).toContain('已发现 1 个工具');
    await click(button('文件服务', false));
    expect(container.textContent).toContain('read_file');
    expect(container.textContent).toContain('读取文件');

    await click(button('编辑', true));
    expect(document.getElementById('mobile-mcp-name')).toHaveProperty('value', '文件服务');
    await setField('mobile-mcp-url', 'https://new.example.com/mcp');
    await click(button('保存'));
    expect(tauriMock.mcpUpdateServer).toHaveBeenCalledWith('server-1', expect.objectContaining({
      url: 'https://new.example.com/mcp',
      headers: { Authorization: 'Bearer token' },
    }));

    await click(document.querySelector('[aria-label="刷新 文件服务 的工具"]')!);
    expect(tauriMock.mcpRefreshTools).toHaveBeenCalledWith('server-1');
    await click(document.querySelector('[aria-label="停用 文件服务"]')!);
    expect(tauriMock.mcpToggleServer).toHaveBeenCalledWith('server-1');
  });

  it('从 JSON 导入地址和鉴权头，再通过现有 store 添加', async () => {
    await renderSection();
    await click(button('添加 MCP'));
    await click(button('粘贴 JSON', false));
    await click(button('返回'));
    expect(dialog().textContent).toContain('手动填写');
    await click(button('粘贴 JSON', false));
    await setField('mobile-mcp-json', JSON.stringify({
      mcpServers: {
        docs: {
          url: 'https://docs.example.com/mcp',
          headers: { Authorization: 'Bearer docs-token' },
        },
      },
    }));
    await click(button('继续'));

    expect(document.getElementById('mobile-mcp-name')).toHaveProperty('value', 'docs');
    await click(button('保存'));
    expect(tauriMock.mcpAddServer).toHaveBeenCalledWith({
      name: 'docs',
      url: 'https://docs.example.com/mcp',
      headers: { Authorization: 'Bearer docs-token' },
      enabled: true,
      trusted: false,
    });
  });

  it('保存失败保留弹层，并显示结构化错误而不是对象字符串', async () => {
    tauriMock.mcpAddServer.mockRejectedValue({ kind: 'Config', message: '无法写入密钥存储' });
    await renderSection();
    await click(button('添加 MCP'));
    await click(button('手动填写', false));
    await click(button('保存'));
    expect(dialog().textContent).toContain('名称不能为空');
    expect(container.textContent).not.toContain('名称不能为空');

    await setField('mobile-mcp-name', '测试');
    await setField('mobile-mcp-url', 'https://example.com/mcp');
    await click(button('保存'));
    expect(dialog().textContent).toContain('无法写入密钥存储');
    expect(dialog().textContent).not.toContain('[object Object]');
  });

  it('删除先确认，成功后从列表移除', async () => {
    tauriMock.mcpListServers.mockResolvedValue(serverList([SERVER]));
    await renderSection();
    await click(button('文件服务', false));
    await click(button('删除', true));
    expect(dialog().textContent).toContain('Agent 将不再获得');
    expect(tauriMock.mcpDeleteServer).not.toHaveBeenCalled();

    tauriMock.mcpListServers.mockResolvedValue(serverList());
    const confirmButton = Array.from(dialog().querySelectorAll('button')).find(
      (el) => el.textContent?.trim() === '删除',
    );
    if (!confirmButton) throw new Error('找不到删除确认按钮');
    await click(confirmButton);
    expect(tauriMock.mcpDeleteServer).toHaveBeenCalledWith('server-1');
    expect(container.textContent).toContain('还没有外部 MCP');
  });

  it('Android 返回先关闭当前弹层，不会误触下面的列表', async () => {
    await renderSection();
    await click(button('添加 MCP'));
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    await settle();

    let consumed = false;
    await act(async () => {
      consumed = window.__marcelHandleBack?.() ?? false;
    });
    await settle();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });
    expect(consumed).toBe(true);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
  });
});
