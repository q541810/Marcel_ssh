// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FileLinkChip from './FileLinkChip';
import MarkdownBody from './MarkdownBody';
import { useSessionStore } from '@/stores/sessionStore';
import { useConnectionStore } from '@/stores/connectionStore';
import { useFileNavStore } from '@/stores/fileNavStore';
import type { Session } from '@/lib/types';

const nav = vi.hoisted(() => ({
  runFileAction: vi.fn(async () => {}),
  runDefaultFileAction: vi.fn(async () => {}),
  copyWithNotice: vi.fn(async () => {}),
}));

vi.mock('@/lib/fileNav', () => ({
  ...nav,
  isMobileShell: () => false,
  canShowFileManager: () => true,
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

  it('a folder is plain blue path text: full path shown, no pill, no icon, click goes to it', async () => {
    const file = { side: 'remote' as const, host: null, path: '/srv/app/logs', isDir: true };
    await act(async () => root.render(<FileLinkChip file={file} />));
    expect(chip().textContent).toBe('/srv/app/logs');
    expect(chip().querySelector('svg')).toBeNull();
    expect(chip().className).not.toContain('bg-state-soft');
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
    expect(labels.some((l) => l.includes('在编辑器中打开'))).toBe(false);
    expect(labels.some((l) => l.includes('/data/a.md'))).toBe(true);
    const reveal = Array.from(document.querySelectorAll('[role="menu"] button')).find((b) =>
      (b.textContent ?? '').includes('在文件管理中显示'),
    ) as HTMLButtonElement;
    await act(async () => reveal.click());
    expect(nav.runFileAction).toHaveBeenCalledWith('reveal', file, expect.anything());
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

describe('MarkdownBody 行内代码路径兜底', () => {
  const chips = () => Array.from(host.querySelectorAll('[data-file-link]')) as HTMLButtonElement[];
  const renderMd = (content: string) => act(async () => root.render(<MarkdownBody sync content={content} />));

  it('agent 没写 remote: 链接、只把绝对路径放进行内代码时，照样渲染成可点的芯片（表格里也行）', async () => {
    await renderMd(
      '配置在 `/opt/1panel/openresty/conf/nginx.conf`，备份在 `/data/backup/x-2026-11-07/`。\n\n| 文件 | 说明 |\n|---|---|\n| `/srv/app/main.go` | 入口 |\n',
    );
    expect(chips().map((c) => c.textContent)).toEqual([
      '/opt/1panel/openresty/conf/nginx.conf',
      '/data/backup/x-2026-11-07/',
      '/srv/app/main.go',
    ]);
    await act(async () => chips()[0].click());
    expect(nav.runDefaultFileAction).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'remote', host: null, path: '/opt/1panel/openresty/conf/nginx.conf' }),
      expect.anything(),
    );
    await act(async () => chips()[1].click());
    expect(nav.runDefaultFileAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: '/data/backup/x-2026-11-07', isDir: true }),
      expect.anything(),
    );
  });

  it('接口路由、相对路径、普通代码保持原样；围栏代码块里的路径不动', async () => {
    await renderMd(
      '`/admin/requests` 和 `extensions/a.go` 和 `kubectl get pods`\n\n```\n/etc/nginx/nginx.conf\n```\n\n```bash\ncat /etc/hosts\n```\n',
    );
    expect(chips()).toHaveLength(0);
    expect(host.querySelectorAll('code').length).toBe(5);
  });

  it('链接文字里夹着行内代码时不套出第二个芯片', async () => {
    await renderMd('[`/etc/nginx/nginx.conf`](remote:/etc/nginx/nginx.conf)');
    expect(chips()).toHaveLength(1);
    expect(host.querySelectorAll('button button').length).toBe(0);
  });
});

