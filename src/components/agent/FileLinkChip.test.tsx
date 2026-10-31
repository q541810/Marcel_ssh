// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FileLinkChip from './FileLinkChip';
import PresentFileView from './PresentFileCard';
import MarkdownBody from './MarkdownBody';
import { useSessionStore } from '@/stores/sessionStore';
import { useConnectionStore } from '@/stores/connectionStore';
import { useFileNavStore } from '@/stores/fileNavStore';
import type { AgentMessage, Session } from '@/lib/types';

const nav = vi.hoisted(() => ({
  runFileAction: vi.fn(async () => {}),
  runDefaultFileAction: vi.fn(async () => {}),
  copyWithNotice: vi.fn(async () => {}),
}));

vi.mock('@/lib/fileNav', () => ({
  ...nav,
  isMobileShell: () => false,
  boundSessionOf: () => 's1',
  findProjectRoot: async () => null,
  getRemoteHome: async () => '/home/u',
}));
vi.mock('@/lib/externalLinks', () => ({ openExternalLink: vi.fn() }));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const session = (over: Partial<Session> = {}): Session => ({
  id: 's1',
  connectionId: 'c1',
  configId: 'c1',
  status: 'connected',
  createdAt: '2026-01-01',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  useSessionStore.setState({ sessions: { s1: session() }, activeSessionId: 's1' });
  useConnectionStore.setState({ connections: [{ id: 'c1', name: 'web' }] } as never);
  useFileNavStore.setState({ notice: null });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});

const chip = () => host.querySelector('[data-file-link]') as HTMLButtonElement;

describe('FileLinkChip', () => {
  it('left click runs the default action on the file', async () => {
    const file = { side: 'remote' as const, host: null, path: '/data/a.md' };
    await act(async () => root.render(<FileLinkChip file={file} />));
    expect(chip().textContent).toBe('a.md');
    expect(chip().title).toContain('/data/a.md');
    await act(async () => chip().click());
    expect(nav.runDefaultFileAction).toHaveBeenCalledWith(file, expect.anything());
  });

  it('right click opens the menu and runs the chosen action', async () => {
    const file = { side: 'remote' as const, host: null, path: '/data/a.md' };
    await act(async () => root.render(<FileLinkChip file={file} />));
    await act(async () => {
      chip().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    });
    const labels = Array.from(document.querySelectorAll('[role="menu"] button')).map((b) => b.textContent ?? '');
    expect(labels.some((l) => l.includes('在编辑器中打开'))).toBe(true);
    expect(labels.some((l) => l.includes('/data/a.md'))).toBe(true);
    const editor = Array.from(document.querySelectorAll('[role="menu"] button')).find((b) =>
      (b.textContent ?? '').includes('在编辑器中打开'),
    ) as HTMLButtonElement;
    await act(async () => editor.click());
    expect(nav.runFileAction).toHaveBeenCalledWith('editor', file, expect.anything());
  });

  it('is disabled with the reason when the machine is not connected, and click explains instead of opening', async () => {
    useSessionStore.setState({ sessions: { s1: session({ status: 'disconnected' }) } });
    const file = { side: 'remote' as const, host: null, path: '/data/a.md' };
    await act(async () => root.render(<FileLinkChip file={file} />));
    expect(chip().getAttribute('aria-disabled')).toBe('true');
    expect(chip().title).toContain('断开');
    await act(async () => chip().click());
    expect(nav.runDefaultFileAction).not.toHaveBeenCalled();
    expect(useFileNavStore.getState().notice?.text).toContain('断开');
  });
});

describe('MarkdownBody file links', () => {
  it('renders remote: links as chips (angle-bracket destination with spaces) and keeps other links', async () => {
    await act(async () =>
      root.render(
        <MarkdownBody
          sync
          content={'见 [报告](<remote:/data/my report.md>) 和 [官网](https://example.com)'}
        />,
      ),
    );
    expect(chip().textContent).toBe('报告');
    await act(async () => chip().click());
    expect(nav.runDefaultFileAction).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'remote', path: '/data/my report.md' }),
      expect.anything(),
    );
    expect(host.querySelectorAll('a').length).toBe(1);
  });
});

describe('PresentFileView', () => {
  const msg = (success: boolean, metadata?: Record<string, unknown>): AgentMessage =>
    ({
      id: 'm1',
      role: 'tool',
      toolResult: { toolName: 'present_file', success, result: 'ok', arguments: {}, metadata },
    }) as unknown as AgentMessage;

  it('renders the delivery card and wires the buttons', async () => {
    await act(async () =>
      root.render(
        <PresentFileView
          message={msg(true, {
            kind: 'presentFile', path: '/data/out.csv', isDir: false, size: 2048,
            side: 'remote', host: null, title: '导出结果', note: '共 12 行',
          })}
        />,
      ),
    );
    expect(host.textContent).toContain('交付文件');
    expect(host.textContent).toContain('导出结果');
    expect(host.textContent).toContain('共 12 行');
    expect(host.textContent).toContain('/data/out.csv');
    const buttons = Array.from(host.querySelectorAll('button'));
    await act(async () => buttons.find((b) => b.textContent === '在文件管理中显示')!.click());
    expect(nav.runFileAction).toHaveBeenCalledWith('reveal', expect.objectContaining({ path: '/data/out.csv' }), expect.anything());
    await act(async () => buttons.find((b) => b.textContent === '打开')!.click());
    expect(nav.runDefaultFileAction).toHaveBeenCalled();
  });

  it('falls back to the plain tool card for failed calls', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    await act(async () => root.render(<PresentFileView message={msg(false)} />));
    expect(host.textContent).not.toContain('打开');
  });
});
