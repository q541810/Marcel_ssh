// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as Record<string, unknown>).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const mocks = vi.hoisted(() => ({
  sftpListDir: vi.fn(),
  sftpHomeDir: vi.fn(),
}));

vi.mock('@/components/terminal/TerminalInstanceManager', () => ({
  terminalInstanceManager: {
    showDisconnectBanner: vi.fn(),
    onReconnected: vi.fn(),
    setStdinEnabled: vi.fn(),
    dispose: vi.fn(),
  },
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ stat: vi.fn() }));
vi.mock('@/lib/tauri', () => ({
  sftpListDir: mocks.sftpListDir,
  sftpHomeDir: mocks.sftpHomeDir,
  sftpMkdir: vi.fn(),
  sftpRemove: vi.fn(),
  sftpRemoveViaShell: vi.fn(),
  sftpRename: vi.fn(),
  sftpReadFile: vi.fn(),
  sftpWriteFile: vi.fn(),
  sftpExtractArchive: vi.fn(),
}));
vi.mock('@/hooks/useSftpUpload', () => ({
  useSftpUpload: () => ({ uploadFile: vi.fn(), pickFolder: vi.fn(), uploadFolder: vi.fn() }),
}));
vi.mock('@/hooks/useSftpDownload', () => ({
  useSftpDownload: () => ({ startDownload: vi.fn() }),
}));
vi.mock('@/stores/settingsStore', () => {
  const stub = {
    settings: {
      fileManagerPath: '/',
      fileManagerPaths: {},
      fileManagerShowHidden: false,
      fileManagerTreeWidth: 200,
      fileManagerTreeUserHidden: false,
    },
    loaded: true,
    update: vi.fn(),
  };
  return {
    useSettingsStore: Object.assign(
      (selector: (s: typeof stub) => unknown) => selector(stub),
      { getState: () => stub },
    ),
  };
});

const FileManagerPanel = (await import('@/components/sftp/FileManagerPanel')).default;

import { useFileNavStore } from '@/stores/fileNavStore';

const entries = [
  { name: 'docs', is_dir: true, is_file: false, is_symlink: false, size: 0, mode: 0o755 },
  { name: 'a.txt', is_dir: false, is_file: true, is_symlink: false, size: 12, mode: 0o644 },
  { name: 'b.txt', is_dir: false, is_file: true, is_symlink: false, size: 7, mode: 0o644 },
];

let container: HTMLDivElement;
let root: Root;

const row = (name: string) =>
  container.querySelector(`[data-file-name="${name}"]`) as HTMLElement;

async function mount() {
  await act(async () => {
    root.render(<FileManagerPanel sessionId="sess-1" connectionKey="conn-1" />);
  });
  await act(async () => {});
}

beforeEach(() => {
  localStorage.clear();
  mocks.sftpListDir.mockReset();
  mocks.sftpListDir.mockResolvedValue(entries);
  mocks.sftpHomeDir.mockReset();
  mocks.sftpHomeDir.mockResolvedValue('/');
  useFileNavStore.setState({ pending: {}, notice: null });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/**
 * agent 链接「在文件管理中显示」：只把那一行标出来（资源管理器式的单选高亮），
 * 不能勾选它——勾选会弹出「已选 1 个 · 复制/剪切/删除」批量操作条，用户根本没要批量。
 */
describe('桌面文件管理器：定位文件只设焦点，不进入批量选择', () => {
  const reveal = async () => {
    await act(async () => {
      useFileNavStore.getState().push({
        sessionId: 'sess-1',
        path: '/a.txt',
        isDir: false,
        size: 12,
        intent: 'reveal',
      });
    });
    await act(async () => {});
  };

  it('目标行持久高亮（bg-state-selected），没有「已选」操作条，也没有被勾选', async () => {
    await mount();
    await reveal();
    expect(row('a.txt').className).toContain('bg-state-selected');
    expect(row('a.txt').getAttribute('aria-selected')).toBe('true');
    expect(container.textContent).not.toContain('已选');
    expect(container.querySelector<HTMLInputElement>('[data-file-name="a.txt"] input[type="checkbox"]')?.checked).toBe(false);
  });

  it('点别的行：高亮跟着走；点空白处：取消；都不会产生勾选', async () => {
    await mount();
    await reveal();
    await act(async () => {
      row('b.txt').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(row('a.txt').className).not.toContain('bg-state-selected');
    expect(row('b.txt').className).toContain('bg-state-selected');

    await act(async () => {
      container.querySelector('th')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(row('b.txt').className).not.toContain('bg-state-selected');
    expect(container.textContent).not.toContain('已选');
  });

  it('勾选了任何行就进入批量选择：焦点高亮让位', async () => {
    await mount();
    await reveal();
    const checkbox = container.querySelector<HTMLInputElement>('[data-file-name="b.txt"] input[type="checkbox"]')!;
    await act(async () => {
      checkbox.click();
    });
    expect(container.textContent).toContain('已选 1 个');
    expect(row('a.txt').className).not.toContain('bg-state-selected');
  });
});
