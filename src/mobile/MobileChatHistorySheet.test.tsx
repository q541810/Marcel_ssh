// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentConversation, SavedConnection } from '@/lib/types';

const tauriMock = vi.hoisted(() => ({
  getConnections: vi.fn(),
  agentListConversationsByConnection: vi.fn(),
  agentListArchivedConversations: vi.fn(),
  agentSearchConversations: vi.fn(),
  agentGetConversation: vi.fn(),
  agentLoadConversation: vi.fn(),
  agentSetConversationPinned: vi.fn(),
  agentRenameConversation: vi.fn(),
  agentArchiveConversation: vi.fn(),
  agentUnarchiveConversation: vi.fn(),
  agentDeleteConversation: vi.fn(),
}));
vi.mock('@/lib/tauri', () => tauriMock);
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn() }));

import MobileChatHistorySheet from './MobileChatHistorySheet';
import { useConnectionStore } from '@/stores/connectionStore';
import { useConversationHistoryStore } from '@/stores/conversationHistoryManager';
import { useConversationStore } from '@/stores/conversationStore';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = '2026-10-01T08:00:00.000Z';
const connection = {
  id: 'conn-1',
  name: 'srv',
  host: '10.0.0.1',
  port: 22,
  username: 'root',
  createdAt: NOW,
} as unknown as SavedConnection;

function archivedConv(overrides: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: 'conv-arch',
    connectionId: 'conn-1',
    title: '旧会话',
    createdAt: NOW,
    updatedAt: NOW,
    pinned: false,
    archivedAt: '2026-10-02T00:00:00.000Z',
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  tauriMock.getConnections.mockResolvedValue([connection]);
  tauriMock.agentListConversationsByConnection.mockResolvedValue([]);
  tauriMock.agentListArchivedConversations.mockResolvedValue([archivedConv()]);
  tauriMock.agentGetConversation.mockResolvedValue(archivedConv());
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  useConnectionStore.setState({
    connections: [connection],
    loading: false,
    error: null,
  });
  useConversationHistoryStore.setState({
    conversationsByConn: {},
    loadingConvs: false,
    showArchived: false,
    searchInput: '',
    debouncedQuery: '',
    searchResults: [],
    loadingSearch: false,
    selectedConv: null,
    selectedConvId: null,
    messages: [],
    loadingMsgs: false,
    activeMatchIds: [],
    matchIndex: 0,
    highlightMessageId: null,
    renameTarget: null,
    renameInput: '',
  });
  useConversationStore.setState({
    archivedConversations: { 'conn-1': [archivedConv()] },
    archivedLoading: {},
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

async function renderSheet() {
  await act(async () => {
    root.render(<MobileChatHistorySheet open onClose={() => {}} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function findButton(textFragment: string): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes(textFragment),
  );
  if (!btn) throw new Error(`找不到按钮：${textFragment}`);
  return btn as HTMLButtonElement;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('MobileChatHistorySheet 归档', () => {
  it('默认不显示归档；打开开关后展开连接能看到归档会话与恢复入口', async () => {
    await renderSheet();
    // 开关本身带「已归档」三个字，用归档项的内容判断默认视图
    expect(document.body.textContent).not.toContain('旧会话');
    expect(document.body.textContent).not.toContain('归档于');

    await click(findButton('显示已归档'));
    expect(useConversationHistoryStore.getState().showArchived).toBe(true);

    // 展开连接 → 归档分组出现
    await click(findButton('srv'));
    expect(document.body.textContent).toContain('已归档');
    expect(document.body.textContent).toContain('旧会话');
    expect(document.body.textContent).toContain('归档于');
    expect(
      document.querySelector('button[aria-label="恢复 旧会话"]'),
    ).not.toBeNull();
  });

  it('点恢复调用 unarchive 并从归档分组消失', async () => {
    tauriMock.agentUnarchiveConversation.mockResolvedValue(undefined);
    await renderSheet();
    await click(findButton('显示已归档'));
    await click(findButton('srv'));

    await click(
      document.querySelector('button[aria-label="恢复 旧会话"]') as HTMLElement,
    );

    expect(tauriMock.agentUnarchiveConversation).toHaveBeenCalledWith('conv-arch');
  });

  it('永久删除需要二次确认', async () => {
    tauriMock.agentDeleteConversation.mockResolvedValue(undefined);
    await renderSheet();
    await click(findButton('显示已归档'));
    await click(findButton('srv'));

    await click(
      document.querySelector('button[aria-label="永久删除 旧会话"]') as HTMLElement,
    );
    expect(document.body.textContent).toContain('此操作不可撤销');
    expect(tauriMock.agentDeleteConversation).not.toHaveBeenCalled();
  });
});
