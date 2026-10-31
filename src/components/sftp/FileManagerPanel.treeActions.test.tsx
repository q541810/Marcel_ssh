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
  sftpRemove: vi.fn(),
  sftpMkdir: vi.fn(),
  sendCdToTerminal: vi.fn(),
}));

vi.mock('@/components/terminal/TerminalInstanceManager', () => ({
  terminalInstanceManager: { get: vi.fn(() => undefined) },
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ stat: vi.fn() }));
vi.mock('@/lib/tauri', () => ({
  sftpListDir: mocks.sftpListDir,
  sftpHomeDir: mocks.sftpHomeDir,
  sftpMkdir: mocks.sftpMkdir,
  sftpRemove: mocks.sftpRemove,
  sftpRemoveViaShell: vi.fn(),
  sftpRename: vi.fn(),
  sftpReadFile: vi.fn(),
  sftpWriteFile: vi.fn(),
  sftpExtractArchive: vi.fn(),
}));
vi.mock('@/lib/fileShellActions', () => ({
  sendCdToTerminal: mocks.sendCdToTerminal,
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
      workspaceLayout: { agentOpen: true },
    },
    loaded: true,
    update: vi.fn(async () => {}),
  };
  return {
    useSettingsStore: Object.assign(
      (selector: (s: typeof stub) => unknown) => selector(stub),
      { getState: () => stub },
    ),
  };
});

const FileManagerPanel = (await import('@/components/sftp/FileManagerPanel')).default;

const dir = (name: string) => ({
  name,
  is_dir: true,
  is_file: false,
  is_symlink: false,
  size: 0,
  mode: 0o755,
});

let container: HTMLDivElement;
let root: Root;

async function mount() {
  await act(async () => {
    root.render(<FileManagerPanel sessionId="sess-1" connectionKey="conn-1" />);
  });
  await act(async () => {});
}

const treeRow = (path: string) =>
  container.querySelector<HTMLElement>(`[role="treeitem"][data-tree-path="${path}"]`)!;

async function rightClick(path: string) {
  await act(async () => {
    treeRow(path).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 }),
    );
  });
}

const menuLabels = () =>
  Array.from(document.body.querySelectorAll('[role="menu"] button')).map((b) => b.textContent);

async function clickMenu(label: string) {
  const btn = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menu"] button')).find(
    (b) => b.textContent === label,
  )!;
  await act(async () => {
    btn.click();
  });
}

beforeEach(() => {
  localStorage.clear();
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.sftpListDir.mockImplementation(async (_s: string, path: string) =>
    path === '/' ? [dir('etc'), dir('srv')] : [],
  );
  mocks.sftpHomeDir.mockResolvedValue('/home/u');
  mocks.sendCdToTerminal.mockResolvedValue(undefined);
  mocks.sftpRemove.mockResolvedValue(undefined);
  mocks.sftpMkdir.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

describe('桌面目录树：右键菜单与共享动作', () => {
  it('目录节点右键：弹出菜单，不导航，行有高亮', async () => {
    await mount();
    await rightClick('/etc');
    // 菜单项与顺序固定（无剪贴板时没有「粘贴到此文件夹」）
    expect(menuLabels()).toEqual(['复制路径', '在终端中打开', '新建文件夹', '重命名', '删除']);
    expect(treeRow('/etc').className).toContain('bg-state-mid');
    // 右键没有导航：列表仍然是 `/`
    expect(mocks.sftpListDir.mock.calls.filter((c) => c[1] === '/etc')).toHaveLength(0);
  });

  it('根目录菜单没有重命名 / 删除', async () => {
    await mount();
    await rightClick('/');
    expect(menuLabels()).not.toContain('重命名');
    expect(menuLabels()).not.toContain('删除');
    expect(menuLabels()).toEqual(['复制路径', '在终端中打开', '新建文件夹']);
  });

  it('在终端中打开：往本会话终端发 cd 到该节点', async () => {
    await mount();
    await rightClick('/srv');
    await clickMenu('在终端中打开');
    expect(mocks.sendCdToTerminal).toHaveBeenCalledWith('sess-1', '/srv');
  });

  it('删除：先确认，确认后按绝对路径删除并刷新父目录', async () => {
    await mount();
    await rightClick('/etc');
    await clickMenu('删除');
    expect(mocks.sftpRemove).not.toHaveBeenCalled();
    const confirm = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent === '确认删除',
    )!;
    const listsBefore = mocks.sftpListDir.mock.calls.length;
    await act(async () => {
      confirm.click();
    });
    expect(mocks.sftpRemove).toHaveBeenCalledWith('sess-1', '/etc', true);
    // 父目录 `/`（当前目录）被重新列出
    expect(mocks.sftpListDir.mock.calls.length).toBeGreaterThan(listsBefore);
  });

  it('新建文件夹：建在被点的节点下，而不是当前目录', async () => {
    await mount();
    await rightClick('/srv');
    await clickMenu('新建文件夹');
    const input = document.body.querySelector<HTMLInputElement>('input[placeholder="新文件夹名称"]')!;
    expect(container.textContent).toContain('在 /srv 下');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'logs');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(mocks.sftpMkdir).toHaveBeenCalledWith('sess-1', '/srv/logs');
  });

  it('顶部有主目录快捷项', async () => {
    await mount();
    const home = container.querySelector('[data-row-key="home:/home/u"]');
    expect(home?.textContent).toContain('主目录');
  });
});
