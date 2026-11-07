// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SftpFileEntry } from '@/lib/types';
import type { StoredTransferItem } from '@/stores/transferStore';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom 不实现 ResizeObserver，MobileSheet 用它测滚动区域 —— 补个空壳即可
(globalThis as Record<string, unknown>).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const mocks = vi.hoisted(() => ({
  sftpListDir: vi.fn(),
  sftpHomeDir: vi.fn(),
  sftpRename: vi.fn(async () => {}),
  sftpPasteEntry: vi.fn(async () => 'a (1).txt'),
  saveSettings: vi.fn(async () => {}),
  writeText: vi.fn(async () => {}),
}));

vi.mock('@/lib/tauri', () => ({
  sftpListDir: mocks.sftpListDir,
  sftpHomeDir: mocks.sftpHomeDir,
  sftpRename: mocks.sftpRename,
  sftpPasteEntry: mocks.sftpPasteEntry,
  saveSettings: mocks.saveSettings,
  mobileSetAppForeground: vi.fn(async () => {}),
  agentPurgeExpiredArchived: vi.fn(async () => 0),
  sftpExtractArchive: vi.fn(async () => {}),
  sftpLocalFileName: vi.fn(async () => 'x'),
  sftpMkdir: vi.fn(async () => {}),
  sftpRemove: vi.fn(async () => {}),
  sftpRemoveViaShell: vi.fn(async () => {}),
  sftpWriteFile: vi.fn(async () => {}),
  isContentUri: (p: string) => p.startsWith('content://'),
}));

// 只保留真实的 MobileFilesHost（被测层）与 App 的返回键兜底；其余宿主/浮层与本
// 用例无关，抹平成空组件，避免把整套 store 依赖拖进来。
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  writeText: mocks.writeText,
}));
vi.mock('@/hooks/useSftpUpload', () => ({
  useSftpUpload: () => ({ uploadFile: vi.fn() }),
}));
vi.mock('@/hooks/useSftpDownload', () => ({
  useSftpDownload: () => ({ startDownload: vi.fn() }),
}));
vi.mock('@/stores/transferScheduler', () => ({ cancelTransfer: vi.fn() }));
vi.mock('./mobileBridge', () => ({
  withForegroundKeepAlive: (_enabled: boolean, run: () => unknown) => run(),
}));
// 压缩面板换成一行可见的标记，用来断言「拿到的是哪个目录」
vi.mock('./MobileCompressSheet', () => ({
  default: ({ remoteDir }: { remoteDir: string }) => (
    <div data-compress-dir={remoteDir} />
  ),
}));
vi.mock('./MobileFileEditor', () => ({
  default: ({
    filePath,
    onClose,
    onCloseStart,
  }: {
    filePath: string;
    onClose: () => void;
    onCloseStart?: () => void;
  }) => (
    <div data-editor-path={filePath}>
      {/* 与真实编辑器一致：关闭开始先通知，退出动画结束再 onClose */}
      <button
        type="button"
        data-editor-close=""
        onClick={() => {
          onCloseStart?.();
          onClose();
        }}
      />
    </div>
  ),
}));
vi.mock('./MobileImageViewer', () => ({ default: () => null }));
vi.mock('./MobileTerminalHost', () => ({ default: () => null }));
vi.mock('./MobileAgentHost', () => ({ default: () => null }));
vi.mock('./MobileSettings', () => ({ default: () => null }));
vi.mock('./MobileOnboarding', () => ({ default: () => null }));
vi.mock('./MobileUpdateToast', () => ({ default: () => null }));
vi.mock('./MobileStarPromptSheet', () => ({ default: () => null }));
vi.mock('./MobileGlobalInteractionOverlay', () => ({ default: () => null }));
vi.mock('./bootstrap', () => ({
  bootstrapMobileApp: vi.fn(async () => {}),
}));
vi.mock('@/stores/interactionStore', () => ({
  initInteractionListener: vi.fn(() => () => {}),
}));
vi.mock('@/stores/jobWake', () => ({ initJobWake: vi.fn(() => () => {}) }));
vi.mock('@/stores/jobStore', () => ({
  useJobStore: {
    getState: () => ({
      initEventListener: () => () => {},
      fetchJobs: async () => {},
    }),
  },
}));
vi.mock('@/stores/updateStore', () => ({
  useUpdateStore: { getState: () => ({ init: async () => {} }) },
}));
vi.mock('@/stores/sftpTransferManager', () => ({
  attachTransferListeners: vi.fn(),
  detachTransferListeners: vi.fn(),
}));

import MobileApp from './App';
import { useSessionStore } from '@/stores/sessionStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTransferStore } from '@/stores/transferStore';
import { resetBackHandlers } from './backHandler';
import { useFileClipboardStore } from '@/stores/fileClipboardStore';
import { useFileNavStore } from '@/stores/fileNavStore';
import { requestMobileTab } from './tabs';
import { FILE_MANAGER_PATH_MEMORY_STORAGE_KEY } from '@/lib/fileManagerPathMemory';

const SESSION = {
  id: 's1',
  connectionId: 'user@host:22',
  configId: 'cfg-1',
  status: 'connected' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const DIR: SftpFileEntry = {
  name: 'docs',
  is_dir: true,
  is_file: false,
  is_symlink: false,
  size: 0,
  mode: 0o755,
};
const FILE: SftpFileEntry = {
  name: 'a.txt',
  is_dir: false,
  is_file: true,
  is_symlink: false,
  size: 12,
  mode: 0o644,
};

let container: HTMLDivElement;
let root: Root;

function setRememberedPath(path: string | undefined) {
  const settings = useSettingsStore.getState().settings;
  useSettingsStore.setState({
    loaded: true,
    settings: {
      ...settings,
      hasCompletedOnboarding: true,
      fileManagerPath: '/',
      fileManagerPaths: path ? { 'cfg-1': path } : {},
      mobileBackgroundSettings: {
        ...settings.mobileBackgroundSettings,
        keepAliveEnabled: false,
      },
    },
  });
}

function findButton(label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(label),
  );
  expect(button, `未找到「${label}」按钮`).toBeTruthy();
  return button as HTMLButtonElement;
}

/** 图标按钮没有文字，按 aria-label 找 */
function findByLabel(label: string): HTMLButtonElement {
  const button = container.querySelector(`button[aria-label="${label}"]`);
  expect(button, `未找到「${label}」按钮`).toBeTruthy();
  return button as HTMLButtonElement;
}

function findBodyButton(label: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(label),
  );
  expect(button, `未找到「${label}」按钮`).toBeTruthy();
  return button as HTMLButtonElement;
}

async function click(button: HTMLElement) {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await act(async () => {});
}

function activeTabLabel(): string {
  const nav = container.querySelector('nav[aria-label="主导航"]');
  const active = nav?.querySelector('button[aria-current="page"]');
  return active?.textContent ?? '';
}

async function switchTab(label: string) {
  const nav = container.querySelector('nav[aria-label="主导航"]');
  const button = [...(nav?.querySelectorAll('button') ?? [])].find((b) =>
    b.textContent?.includes(label),
  );
  expect(button, `未找到「${label}」标签`).toBeTruthy();
  await click(button as HTMLButtonElement);
}

async function mountFilesTab() {
  await act(async () => {
    root.render(<MobileApp />);
  });
  await switchTab('文件');
  await act(async () => {});
}

/** 入队 + 直接推进到目标状态（跳过调度器，模拟传输事件后的 store） */
async function putTransfer(
  id: string,
  patch: Partial<StoredTransferItem> = {},
) {
  await act(async () => {
    useTransferStore.getState().addItem({
      id,
      kind: 'download',
      sessionId: 's1',
      fileName: 'a.txt',
      localPath: '/local/a.txt',
      remotePath: '/srv/a.txt',
      written: 12,
      total: 12,
      statusText: '传输中',
      createdAt: 1,
      ...patch,
    });
  });
  await act(async () => {
    useTransferStore.getState().updateItem(id, patch);
  });
}

beforeEach(() => {
  mocks.sftpListDir.mockReset();
  mocks.sftpListDir.mockResolvedValue([DIR, FILE]);
  mocks.sftpHomeDir.mockReset();
  mocks.sftpHomeDir.mockResolvedValue('/usr/home/u');
  mocks.sftpRename.mockClear();
  mocks.sftpPasteEntry.mockClear();
  useFileClipboardStore.getState().clear();
  mocks.saveSettings.mockClear();
  mocks.writeText.mockClear();
  // 目录记忆落在 localStorage：用例之间必须清空，否则上一条用例的导航会变成下一条的起点。
  localStorage.clear();
  resetBackHandlers();
  useSessionStore.setState({
    sessions: { s1: SESSION },
    activeSessionId: 's1',
  });
  useTransferStore.setState({ items: {}, order: [], open: false });
  setRememberedPath('/home/user');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetBackHandlers();
});

/**
 * 目录记忆：每切一次目录不能再整份保存设置（序列化 + fsync + 重扫插件目录 +
 * 广播设置变更），记忆落在本机 localStorage；旧设置里的记忆仍作兜底。
 */
describe('目录记忆走本机存储而不是整份保存设置', () => {
  async function goUp() {
    await act(async () => {
      window.__marcelHandleBack?.();
    });
    await act(async () => {});
  }

  it('切目录不触发设置保存，记忆写进 localStorage', async () => {
    await mountFilesTab();
    expect(mocks.sftpListDir).toHaveBeenLastCalledWith('s1', '/home/user');

    await goUp();
    expect(mocks.sftpListDir).toHaveBeenLastCalledWith('s1', '/home');

    expect(mocks.saveSettings).not.toHaveBeenCalled();
    const stored = JSON.parse(
      localStorage.getItem(FILE_MANAGER_PATH_MEMORY_STORAGE_KEY) ?? '{}',
    );
    expect(stored.byConnection['cfg-1']).toBe('/home');
  });

  it('重新进入文件页时，本机记忆优先于旧设置里的目录', async () => {
    await mountFilesTab();
    await goUp();
    expect(mocks.sftpListDir).toHaveBeenLastCalledWith('s1', '/home');

    act(() => root.unmount());
    root = createRoot(container);
    mocks.sftpListDir.mockClear();
    await mountFilesTab();

    // 设置里记的仍是 /home/user，但本机记忆是 /home。
    expect(mocks.sftpListDir).toHaveBeenLastCalledWith('s1', '/home');
  });

  it('本机没有记录时，沿用旧设置里该连接的目录', async () => {
    await mountFilesTab();
    expect(mocks.sftpListDir).toHaveBeenLastCalledWith('s1', '/home/user');
    expect(localStorage.getItem(FILE_MANAGER_PATH_MEMORY_STORAGE_KEY)).not.toBeNull();
    expect(mocks.saveSettings).not.toHaveBeenCalled();
  });
});

/**
 * 起始目录读不了（serv00 这类共享主机的普通用户没有 `/` 的读权限，或记住的目录已被删）
 * 时改去家目录，而不是停在一条 Permission denied 上。
 */
describe('起始目录读不了时改去家目录', () => {
  const denied = { kind: 'Ssh', message: 'SSH error: 读取目录失败: Permission denied' };

  it('起始目录被拒：自动进入家目录并正常列出，不留错误条', async () => {
    mocks.sftpListDir.mockImplementation(async (_s: string, path: string) => {
      if (path === '/home/user') throw denied;
      return [DIR, FILE];
    });
    await mountFilesTab();
    await act(async () => {});

    expect(mocks.sftpHomeDir).toHaveBeenCalledWith('s1');
    expect(mocks.sftpListDir).toHaveBeenLastCalledWith('s1', '/usr/home/u');
    expect(container.textContent).not.toContain('加载失败');
    const stored = JSON.parse(
      localStorage.getItem(FILE_MANAGER_PATH_MEMORY_STORAGE_KEY) ?? '{}',
    );
    expect(stored.byConnection['cfg-1']).toBe('/usr/home/u');
  });

  it('家目录也读不了：显示原始错误，不循环重试', async () => {
    mocks.sftpListDir.mockRejectedValue(denied);
    await mountFilesTab();
    await act(async () => {});

    expect(container.textContent).toContain('加载失败');
    // 起始目录一次 + 家目录一次，之后不再反复尝试。
    expect(mocks.sftpListDir).toHaveBeenCalledTimes(2);
  });

  it('取不到家目录（返回的就是失败的目录）：显示原始错误', async () => {
    mocks.sftpHomeDir.mockResolvedValue('/home/user');
    mocks.sftpListDir.mockRejectedValue(denied);
    await mountFilesTab();
    await act(async () => {});

    expect(container.textContent).toContain('加载失败');
    expect(mocks.sftpListDir).toHaveBeenCalledTimes(1);
  });
});

/**
 * 文件页 vs 标签页兜底：返回键的优先级。
 *
 * backHandler 是 LIFO 栈，而 React 同一 commit 里子组件的 useEffect 先于父组件的
 * useEffect 执行。若 App 的「切回终端页」也在 useEffect 里注册，切回文件页那一次
 * 提交就会把它压在文件页「回上一级」之上 —— 第一次返回跳终端页（而不是回上级）。
 */
describe('返回键：文件页优先于标签页兜底', () => {
  it('从终端页切回文件页后，第一次返回是回上一级', async () => {
    await mountFilesTab();
    expect(mocks.sftpListDir).toHaveBeenLastCalledWith('s1', '/home/user');
    expect(activeTabLabel()).toContain('文件');

    let consumed = false;
    await act(async () => {
      consumed = window.__marcelHandleBack?.() ?? false;
    });
    await act(async () => {});

    expect(consumed).toBe(true);
    expect(mocks.sftpListDir).toHaveBeenLastCalledWith('s1', '/home');
    expect(activeTabLabel()).toContain('文件');
  });

  it('在文件页内导航过一次（handler 重新注册）后仍回上一级', async () => {
    await mountFilesTab();

    const pathButton = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'home',
    );
    expect(pathButton).toBeTruthy();
    await click(pathButton as HTMLButtonElement);
    expect(mocks.sftpListDir).toHaveBeenLastCalledWith('s1', '/home');

    await act(async () => {
      window.__marcelHandleBack?.();
    });
    await act(async () => {});

    expect(activeTabLabel()).toContain('文件');
    expect(mocks.sftpListDir).toHaveBeenLastCalledWith('s1', '/');
  });

  it('在根目录（没有上一级）时返回键仍然切回终端页', async () => {
    setRememberedPath(undefined);
    await mountFilesTab();
    expect(mocks.sftpListDir).toHaveBeenLastCalledWith('s1', '/');

    await act(async () => {
      window.__marcelHandleBack?.();
    });
    await act(async () => {});

    expect(activeTabLabel()).toContain('终端');
  });
});

/**
 * 传输成功后必须就地可见：顶部活动条只认 active/cancelling，条目一到 done
 * 就整条消失，用户既不知道成没成，也拿不到文件落点。
 */
describe('传输完成提示', () => {
  it('下载完成后展示「已保存到」本地路径，并能复制该路径', async () => {
    await mountFilesTab();
    await putTransfer('d1', {
      status: 'done',
      statusText: 'a.txt 下载完成',
      finishedAt: Date.now(),
    });

    expect(container.textContent).toContain('已保存到 /local/a.txt');
    await click(findButton('复制路径'));
    expect(mocks.writeText).toHaveBeenCalledWith('/local/a.txt');
  });

  it('上传完成后展示「已上传到」远端路径', async () => {
    await mountFilesTab();
    await putTransfer('u1', {
      kind: 'upload',
      status: 'done',
      statusText: 'a.txt 上传完成',
      remotePath: '/home/user/a.txt',
      finishedAt: Date.now(),
    });

    expect(container.textContent).toContain('已上传到 /home/user/a.txt');
  });

  it('不补播历史完成记录（陈旧条目不提示）', async () => {
    await mountFilesTab();
    await putTransfer('d-old', {
      status: 'done',
      statusText: 'a.txt 下载完成',
      finishedAt: Date.now() - 10 * 60 * 1000,
    });

    expect(container.textContent).not.toContain('已保存到');
  });

  it('失败仍然走错误条，不误报成功', async () => {
    await mountFilesTab();
    await putTransfer('d2', {
      status: 'error',
      statusText: '下载失败：网络中断',
      finishedAt: Date.now(),
    });

    expect(container.textContent).toContain('下载失败：网络中断');
    expect(container.textContent).not.toContain('已保存到');
  });
});

/**
 * 断连态的错误提示：失败常常正是断线那一刻产生的，早退分支
 * （「连接已断开」空状态）不能把错误横幅一起挡掉。
 */
describe('断连时错误可见', () => {
  it('连接断开后仍能看到传输失败原因', async () => {
    await mountFilesTab();

    await act(async () => {
      useSessionStore.setState({
        sessions: { s1: { ...SESSION, status: 'disconnected' } },
      });
    });
    expect(container.textContent).toContain('连接已断开');

    // 「会话已断开，任务已跳过」这类失败只在断连后产生 —— 用 ready 才有的
    // sessionId 去扫 store 是扫不到的，必须按当前会话真实 id 扫
    await putTransfer('d3', {
      status: 'error',
      statusText: '会话已断开，任务已跳过',
      finishedAt: Date.now(),
    });

    expect(container.textContent).toContain('会话已断开，任务已跳过');
  });

  it('失败先到、掉线后到，提示也不会被清掉', async () => {
    await mountFilesTab();
    await putTransfer('d4', {
      status: 'error',
      statusText: '下载失败：网络中断',
      finishedAt: Date.now(),
    });
    expect(container.textContent).toContain('下载失败：网络中断');

    await act(async () => {
      useSessionStore.setState({
        sessions: { s1: { ...SESSION, status: 'disconnected' } },
      });
    });

    expect(container.textContent).toContain('连接已断开');
    expect(container.textContent).toContain('下载失败：网络中断');
  });
});

/**
 * 目录在移动端「点按 = 进入」，永远不会成为 selectedEntry，于是单选操作条里的
 * 压缩 / 重命名对目录是死代码。长按进入的选择模式（单选）必须补上这两个动作。
 */
describe('目录的压缩 / 重命名入口', () => {
  async function longPress(entry: SftpFileEntry) {
    const row = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes(entry.name),
    );
    expect(row, `未找到「${entry.name}」行`).toBeTruthy();
    await act(async () => {
      row!.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
    });
    await act(async () => {});
  }

  it('长按目录 → 单选操作条给出「压缩」，打开的是该目录', async () => {
    await mountFilesTab();
    await longPress(DIR);

    expect(container.textContent).toContain('已选 1 个');
    await click(findButton('压缩'));

    expect(
      container.querySelector('[data-compress-dir]')?.getAttribute(
        'data-compress-dir',
      ),
    ).toBe('/home/user/docs');
    // 压缩面板接管后选择模式收尾，避免操作条和面板叠着
    expect(container.textContent).not.toContain('已选 1 个');
  });

  it('长按目录 → 重命名按目录路径调用 sftpRename', async () => {
    await mountFilesTab();
    await longPress(DIR);

    await click(findButton('重命名'));
    const input = document.body.querySelector(
      'input[type="text"]',
    ) as HTMLInputElement | null;
    expect(input?.value).toBe('docs');

    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    await act(async () => {
      setter.call(input, 'docs2');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(findBodyButton('确定'));

    expect(mocks.sftpRename).toHaveBeenCalledWith(
      's1',
      '/home/user/docs',
      '/home/user/docs2',
    );
  });

  it('选中多个条目时不提供单项动作（压缩只对单个目录）', async () => {
    await mountFilesTab();
    await longPress(DIR);
    await click(findButton('全选'));

    expect(container.textContent).toContain('已选 2 个');
    expect(
      [...container.querySelectorAll('button')].some(
        (b) => b.textContent === '压缩',
      ),
    ).toBe(false);
    expect(
      [...container.querySelectorAll('button')].some(
        (b) => b.textContent === '重命名',
      ),
    ).toBe(false);
  });
});

/**
 * 上传 / 下载是调度器里两条独立 lane，桌面两端可并行；
 * 用一个总布尔禁用会把另一条道白白堵死。
 */
describe('上传 / 下载互不阻塞', () => {
  it('上传进行中时下载入口仍可用（反之亦然）', async () => {
    await mountFilesTab();
    await putTransfer('u-active', {
      kind: 'upload',
      status: 'active',
      statusText: '正在上传 a.txt ...',
    });

    expect(findButton('上传').disabled).toBe(true);

    // 文件行尾「⋯」打开条目操作面板（面板挂在 body 上）
    await click(findByLabel('a.txt 的更多操作'));
    expect(findBodyButton('下载').disabled).toBe(false);
  });

  it('下载进行中时上传按钮仍可用', async () => {
    await mountFilesTab();
    await putTransfer('d-active', {
      kind: 'download',
      status: 'active',
      statusText: '正在下载 a.txt ...',
    });

    expect(findButton('上传').disabled).toBe(false);
  });
});

/**
 * 点按不能改变布局：曾经「点一下选中、再点一下打开」，选中会在列表上方插出一条
 * 操作栏把整张列表顶下去，第二次点按就落在别的文件上。现在点一下就办事，
 * 操作入口收进行尾「⋯」面板。
 */
describe('点按直接打开，不引入位移', () => {
  it('点一下文件就打开它，且列表上方不会冒出操作条', async () => {
    await mountFilesTab();
    const before = [...container.querySelectorAll('li')].map((li) => li.textContent);

    const row = [...container.querySelectorAll('li button')].find((b) =>
      b.textContent?.includes('a.txt'),
    );
    await click(row as HTMLButtonElement);

    expect(
      container.querySelector('[data-editor-path]')?.getAttribute('data-editor-path'),
    ).toBe('/home/user/a.txt');
    // 列表内容与顺序原封不动，也没有任何单项操作按钮冒出来
    expect([...container.querySelectorAll('li')].map((li) => li.textContent)).toEqual(
      before,
    );
    for (const label of ['重命名', '压缩', '解压', '删除']) {
      expect(
        [...container.querySelectorAll('button')].some(
          (b) => b.textContent === label,
        ),
      ).toBe(false);
    }
  });

  it('点一下目录就进入', async () => {
    await mountFilesTab();
    const row = [...container.querySelectorAll('li button')].find((b) =>
      b.textContent?.includes('docs'),
    );
    await click(row as HTMLButtonElement);
    expect(mocks.sftpListDir).toHaveBeenLastCalledWith('s1', '/home/user/docs');
  });

  it('行尾「⋯」给出该条目的操作：文件有下载、目录有压缩', async () => {
    await mountFilesTab();

    await click(findByLabel('a.txt 的更多操作'));
    expect(findBodyButton('下载')).toBeTruthy();
    expect(
      [...document.body.querySelectorAll('button')].some(
        (b) => b.textContent === '压缩',
      ),
    ).toBe(false);
    await click(findBodyButton('关闭'));

    await click(findByLabel('docs 的更多操作'));
    expect(findBodyButton('压缩')).toBeTruthy();
  });
});

/** 软链接的 is_file 在 lstat 语义下是 false —— 不能因此变成死按钮 */
describe('软链接打开', () => {
  const LINK: SftpFileEntry = {
    name: 'link.txt',
    is_dir: false,
    is_file: false,
    is_symlink: true,
    size: 12,
    mode: 0o777,
  };

  it('软链接用链接图标标出，并可进入「打开」流程', async () => {
    mocks.sftpListDir.mockResolvedValue([LINK]);
    await mountFilesTab();

    expect(container.querySelector('[data-kind="link"]')).toBeTruthy();
    expect(container.textContent).toContain('符号链接');

    const row = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('link.txt'),
    );
    await click(row as HTMLButtonElement);

    // 文本类软链接 → 打开编辑器（Mock 为空组件），不应静默无反应
    expect(container.textContent).not.toContain('无法打开');
  });

  it('特殊文件（非 is_file 非 is_symlink）给出明确提示', async () => {
    const FIFO: SftpFileEntry = {
      name: 'pipe',
      is_dir: false,
      is_file: false,
      is_symlink: false,
      size: 0,
      mode: 0o644,
    };
    mocks.sftpListDir.mockResolvedValue([FIFO]);
    await mountFilesTab();

    const row = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('pipe'),
    );
    await click(row as HTMLButtonElement);

    expect(container.textContent).toContain('不是普通文件');
  });
});

describe('复制 / 剪切 + 粘贴', () => {
  it('复制后在当前目录粘贴，重名落地名有提示，复制不清空剪贴板', async () => {
    await mountFilesTab();
    await click(findByLabel('a.txt 的更多操作'));
    await click(findBodyButton('复制'));

    expect(container.textContent).toContain('已复制「a.txt」');
    await click(findButton('粘贴到此处'));

    expect(mocks.sftpPasteEntry).toHaveBeenCalledWith(
      's1',
      '/home/user/a.txt',
      '/home/user',
      false,
    );
    expect(container.textContent).toContain('已另存为：「a (1).txt」');
    expect(useFileClipboardStore.getState().clipboard).not.toBeNull();
  });

  it('剪切粘贴成功后剪贴板作废', async () => {
    mocks.sftpPasteEntry.mockResolvedValueOnce('a.txt');
    await mountFilesTab();
    await click(findByLabel('a.txt 的更多操作'));
    await click(findBodyButton('剪切'));
    await click(findButton('粘贴到此处'));

    expect(mocks.sftpPasteEntry).toHaveBeenCalledWith(
      's1',
      '/home/user/a.txt',
      '/home/user',
      true,
    );
    expect(useFileClipboardStore.getState().clipboard).toBeNull();
  });

  it('剪贴板来自另一台服务器时粘贴按钮置灰', async () => {
    useFileClipboardStore.getState().set({
      sessionId: 'other',
      dir: '/x',
      items: [{ name: 'f', isDir: false }],
      cut: false,
    });
    await mountFilesTab();
    expect(findButton('粘贴到此处').disabled).toBe(true);
    expect(container.textContent).toContain('另一台服务器');
  });
});

// ── 宿主渲染收窄的计数断言 ──────────────────────────────────────────────
// sessionStatusLabel 在有活动会话时每次宿主渲染都会被调用，间谍它的调用次数
// 即宿主渲染次数的代理（进度 tick 只该重渲染传输条小组件，不该动整页）。
const sessionUiSpies = vi.hoisted(() => ({
  sessionStatusLabel: vi.fn((s: string) => s),
  resolveSessionDisplayName: vi.fn((_a: unknown, _b: unknown) => '主机'),
}));
vi.mock('./sessionUi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sessionUi')>();
  return {
    ...actual,
    sessionStatusLabel: sessionUiSpies.sessionStatusLabel,
    resolveSessionDisplayName: sessionUiSpies.resolveSessionDisplayName,
  };
});

describe('传输进度与宿主重渲染', () => {
  it('进度 tick 不重渲染文件列表（宿主只订阅忙布尔与终态条目本体）', async () => {
    await mountFilesTab();
    expect(
      sessionUiSpies.sessionStatusLabel.mock.calls.length,
      '前提：当前用例环境下标签渲染路径确实会走到',
    ).toBeGreaterThan(0);

    await putTransfer('progress-tick', {
      status: 'active',
      written: 0,
      total: 100,
      statusText: '传输中',
    });
    const baseline = sessionUiSpies.sessionStatusLabel.mock.calls.length;

    for (let i = 1; i <= 20; i++) {
      await act(async () => {
        useTransferStore
          .getState()
          .updateItem('progress-tick', { written: i * 5, statusText: `传输中 ${i}` });
      });
    }
    expect(sessionUiSpies.sessionStatusLabel.mock.calls.length).toBe(baseline);
  });
});

/**
 * 从 Agent 对话点路径链接过来：用户得能看见结果、也得能回到原来的位置。
 * 编辑器 / 预览关闭、或「返回对话」，都回到对话页（Agent 页一直挂着，阅读位置还在）。
 */
describe('从 Agent 对话跳到文件：能回去', () => {
  const request = (intent: 'auto' | 'reveal') => {
    act(() => {
      useFileNavStore.getState().push({
        sessionId: 's1',
        path: '/home/user/a.txt',
        isDir: false,
        size: 12,
        intent,
        returnTo: 'agent',
      });
      requestMobileTab('files');
    });
  };

  async function startFromAgent(intent: 'auto' | 'reveal') {
    await act(async () => {
      root.render(<MobileApp />);
    });
    await switchTab('Agent');
    await act(async () => {
      request(intent);
    });
    await act(async () => {});
  }

  it('打开编辑器后关闭：直接回到对话页，不停在文件页', async () => {
    await startFromAgent('auto');
    expect(activeTabLabel()).toContain('文件');
    expect(container.querySelector('[data-editor-path="/home/user/a.txt"]')).toBeTruthy();

    await click(container.querySelector('[data-editor-close]') as HTMLElement);
    expect(activeTabLabel()).toContain('Agent');
    expect(container.querySelector('[data-editor-path]')).toBeNull();
  });

  it('只是在文件管理中显示：该行持久高亮、不进入选择模式，并给出「返回对话」', async () => {
    await startFromAgent('reveal');
    expect(activeTabLabel()).toContain('文件');
    const row = container.querySelector('[data-file-name="a.txt"]') as HTMLElement;
    expect(row.getAttribute('aria-current')).toBe('true');
    expect(row.className).toContain('bg-state-selected');
    expect(container.textContent).not.toContain('已选');
    expect(container.textContent).toContain('返回对话');

    await click(findButton('返回对话'));
    expect(activeTabLabel()).toContain('Agent');
    // 离开文件页后，返回条不能留到下次
    await switchTab('文件');
    expect(container.textContent).not.toContain('返回对话');
  });

  it('返回键先回对话（而不是先回上一级目录）', async () => {
    await startFromAgent('reveal');
    await act(async () => {
      window.__marcelHandleBack?.();
    });
    await act(async () => {});
    expect(activeTabLabel()).toContain('Agent');
  });

  it('用户自己换目录后，返回条与高亮都撤掉', async () => {
    await startFromAgent('reveal');
    expect(container.textContent).toContain('返回对话');
    await click(findButton('docs'));
    expect(container.textContent).not.toContain('返回对话');
    expect(container.querySelector('[aria-current="true"]')).toBeNull();
  });

  it('不是从别的页签来的（没有 returnTo）：没有返回条', async () => {
    await act(async () => {
      root.render(<MobileApp />);
    });
    await switchTab('文件');
    await act(async () => {
      useFileNavStore.getState().push({
        sessionId: 's1',
        path: '/home/user/a.txt',
        isDir: false,
        size: 12,
        intent: 'reveal',
      });
    });
    await act(async () => {});
    expect(container.textContent).not.toContain('返回对话');
    expect(container.querySelector('[data-file-name="a.txt"]')?.getAttribute('aria-current')).toBe('true');
  });
});
