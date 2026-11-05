// @vitest-environment jsdom
/**
 * 工具卡路径芯片：只在卡片展开后显示。
 *
 * 过去写 / 改 / 上传下载的卡片折叠着也在下面挂一排路径芯片，每张卡都带一排，对话被过程信息填得很吵；
 * 现在折叠态只有标题行，要找文件的用户展开卡片即可（成品文件由正文里的路径链接承载）。
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

function renderCard(toolName: string, args: Record<string, unknown>) {
  const message: AgentMessage = {
    id: 'm1',
    role: 'tool',
    content: '',
    timestamp: '2026-01-01T00:00:00Z',
    toolResult: { toolName, success: true, result: '已写入', arguments: args },
  } as AgentMessage;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<ToolCallCard message={message} />));
  return container;
}

const chips = (el: HTMLElement) => el.querySelectorAll('[data-file-link]');

describe('工具卡路径芯片', () => {
  it.each([
    ['write_file', { path: '/srv/app/a.md', content: 'x' }],
    ['upload_file', { remote_path: '/srv/app/b.zip', local_path: 'C:/b.zip' }],
  ])('%s：折叠时不挂芯片，展开后才出现', (toolName, args) => {
    const el = renderCard(toolName, args);
    expect(chips(el).length).toBe(0);
    act(() => {
      el.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(chips(el).length).toBeGreaterThan(0);
  });
});
