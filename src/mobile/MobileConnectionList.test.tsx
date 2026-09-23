// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SavedConnection } from '@/lib/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** MobileSheet / Modal 用它量高度；jsdom 不实现。 */
(globalThis as Record<string, unknown>).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const mocks = vi.hoisted(() => ({
  hasPassword: vi.fn(),
  savePassword: vi.fn(),
  hasPassphrase: vi.fn(),
  savePassphrase: vi.fn(),
  listKeys: vi.fn(),
  connect: vi.fn(),
  connectWithSavedPassword: vi.fn(),
  connectWithSavedPassphrase: vi.fn(),
  disconnect: vi.fn(),
  prompt: vi.fn(),
  privacy: false,
  connections: [] as SavedConnection[],
}));

vi.mock('@/lib/tauri', () => ({
  hasPassword: mocks.hasPassword,
  savePassword: mocks.savePassword,
  hasPassphrase: mocks.hasPassphrase,
  savePassphrase: mocks.savePassphrase,
  listKeys: mocks.listKeys,
}));

vi.mock('@/stores/connectionStore', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      connections: mocks.connections,
      loading: false,
      error: null,
      fetchConnections: vi.fn(),
      addConnection: vi.fn(),
      removeConnection: vi.fn(),
      applyConnectionOrder: vi.fn(),
    }),
}));

vi.mock('@/stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        connect: mocks.connect,
        connectWithSavedPassword: mocks.connectWithSavedPassword,
        connectWithSavedPassphrase: mocks.connectWithSavedPassphrase,
        disconnect: mocks.disconnect,
      }),
    // clearOtherSessions 直接走 getState()，不经 hook
    { getState: () => ({ sessions: {} }) },
  ),
}));

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      settings: { mobileBackgroundSettings: { keepAliveEnabled: true } },
      loaded: true,
    }),
}));

vi.mock('@/hooks/useSessionLifecycle', () => ({
  // 真实实现是 async：调用点写的是 `void onConnected(...).catch(...)`，
  // mock 成同步返回 undefined 会让那条 `.catch` 抛 TypeError（掩盖被测行为）。
  useSessionLifecycle: () => ({
    onConnected: vi.fn().mockResolvedValue(undefined),
    onDisconnected: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@/hooks/useConnectWithPassword', () => ({
  useConnectWithPassword: () => ({ prompt: mocks.prompt, dismiss: vi.fn(), Prompt: null }),
}));

vi.mock('@/hooks/useHostKeyMismatch', () => ({
  useHostKeyMismatch: () => ({ prompt: vi.fn(), Modal: null }),
}));

vi.mock('@/hooks/usePrivacyMode', () => ({ usePrivacyMode: () => mocks.privacy }));

// 新建/编辑连接的浮层与此处无关，渲染它只会把密钥库等依赖拖进来。
vi.mock('@/mobile/MobileConnectionForm', () => ({ default: () => null }));

import MobileConnectionList from './MobileConnectionList';

const PW_CONN: SavedConnection = {
  id: 'c1',
  name: '生产机',
  host: '10.0.0.1',
  port: 22,
  username: 'root',
  authMethod: 'Password',
};

/** 老数据里可能没有名字：删除确认要退到脱敏口径的 user@host:port。 */
const NAMELESS_CONN: SavedConnection = { ...PW_CONN, name: '' };

let container: HTMLDivElement;
let root: Root;

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<MobileConnectionList />);
  });
}

function buttonByLabel(label: string): HTMLButtonElement {
  const el = Array.from(document.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(label),
  );
  if (!el) throw new Error(`找不到按钮：${label}`);
  return el;
}

async function click(label: string) {
  const el = buttonByLabel(label);
  await act(async () => {
    el.click();
  });
  await act(async () => {});
}

/** 后端「服务器拒绝了这份凭据」的唯一线上形态：kind=KeyAuth + data.code。 */
function keyAuthError(code: string, message = '认证失败：用户名或密码错误') {
  return { kind: 'KeyAuth', message, data: { code } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.privacy = false;
  mocks.connections = [PW_CONN];
  mocks.connect.mockResolvedValue('session-1');
  mocks.savePassword.mockResolvedValue(undefined);
  mocks.hasPassword.mockResolvedValue(true);
  mocks.listKeys.mockResolvedValue([]);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = '';
});

/**
 * 与桌面同一套判据、同一套复问：密钥链里那份密码被服务器拒了就重新追问（并覆盖它），
 * 其他原因照实显示红条。两边必须对称，否则同一个 bug 只修了一半。
 */
describe('已保存密码被拒后重新追问', () => {
  it('服务器拒绝密码时重新弹出密码框，并说明这次是"换一份"', async () => {
    mocks.connectWithSavedPassword.mockRejectedValue(keyAuthError('rejected'));

    render();
    await click('生产机');

    expect(mocks.connectWithSavedPassword).toHaveBeenCalledTimes(1);
    expect(mocks.prompt).toHaveBeenCalledTimes(1);
    const asked = mocks.prompt.mock.calls[0][0] as { title: string; description: string };
    expect(asked.title).toBe('SSH 密码');
    expect(asked.description).toContain('上次保存的密码被服务器拒绝');
    expect(asked.description).toContain('root@10.0.0.1:22');
    // 浮层已经把原因说清了，红条不再重复同一句话
    expect(document.body.textContent ?? '').not.toContain('认证失败：用户名或密码错误');
  });

  it('复问时输入的新密码会覆盖密钥链里那份错的，并用它去连', async () => {
    mocks.connectWithSavedPassword.mockRejectedValue(keyAuthError('rejected'));

    render();
    await click('生产机');
    const asked = mocks.prompt.mock.calls[0][0] as {
      onSubmit: (password: string) => Promise<void>;
    };

    await act(async () => {
      await asked.onSubmit('正确的密码');
    });

    expect(mocks.savePassword).toHaveBeenCalledWith('c1', '正确的密码');
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.connect.mock.calls[0][0]).toMatchObject({
      username: 'root',
      authMethod: { type: 'Password', password: '正确的密码' },
    });
  });

  it('别的原因（网络不通等）不追问密码，照实显示红条', async () => {
    mocks.connectWithSavedPassword.mockRejectedValue({
      kind: 'Ssh',
      message: 'SSH error: 连接失败: Network is unreachable',
    });

    render();
    await click('生产机');

    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(document.body.textContent ?? '').toContain('Network is unreachable');
  });

  it('密码框文案过隐私模式口径', async () => {
    mocks.privacy = true;
    mocks.connectWithSavedPassword.mockRejectedValue(keyAuthError('rejected'));

    render();
    await click('生产机');

    const asked = mocks.prompt.mock.calls[0][0] as { description: string };
    expect(asked.description).toContain('root@***:****');
    expect(asked.description).not.toContain('10.0.0.1');
  });
});

/**
 * 删除确认框里的连接称谓：有名字用名字，没名字退到 `formatConnLabel`——
 * 以前是裸插值 `${username}@${host}`，隐私模式下照样把真实主机打在浮层上。
 */
describe('删除确认框走隐私模式口径', () => {
  async function openDeleteConfirm() {
    // 删除按钮只有图标，名字在 aria-label 上（连接没名字时是 "删除 "）
    const el = document.querySelector<HTMLButtonElement>('[aria-label^="删除"]');
    if (!el) throw new Error('找不到删除按钮');
    await act(async () => {
      el.click();
    });
    await act(async () => {});
  }

  it('没有名字的连接在隐私模式下显示 root@***:****', async () => {
    mocks.privacy = true;
    mocks.connections = [NAMELESS_CONN];

    render();
    await openDeleteConfirm();

    const text = document.body.textContent ?? '';
    expect(text).toContain('删除连接「root@***:****」');
    expect(text).not.toContain('10.0.0.1');
  });

  it('没有名字的连接在非隐私模式下显示 user@host:port', async () => {
    mocks.connections = [NAMELESS_CONN];

    render();
    await openDeleteConfirm();

    expect(document.body.textContent ?? '').toContain('删除连接「root@10.0.0.1:22」');
  });

  it('有名字时仍用名字（脱敏只碰主机口径，不动用户起的名字）', async () => {
    mocks.privacy = true;

    render();
    await openDeleteConfirm();

    expect(document.body.textContent ?? '').toContain('删除连接「生产机」');
  });
});

/**
 * 密钥链写入失败必须出声（与桌面 ConnectionList 对称）。
 *
 * 保存失败**不拦连接**（既有取舍），但用户不能被留在"连上了"的表象里——那份密码
 * 根本没记住，下次连接与重连还会再要一次。以前这里静默吞掉。
 */
describe('密钥链写入失败要出声', () => {
  it('密码没能保存：连接照常进行，红条说明这次没记住', async () => {
    mocks.hasPassword.mockResolvedValue(false);
    mocks.savePassword.mockRejectedValue({
      kind: 'Config',
      message: '保存密码到密钥链失败：access denied',
    });

    render();
    await click('生产机');
    const asked = mocks.prompt.mock.calls[0][0] as {
      onSubmit: (password: string) => Promise<void>;
    };
    await act(async () => {
      await asked.onSubmit('pw');
    });

    expect(mocks.connect).toHaveBeenCalledTimes(1);
    const text = document.body.textContent ?? '';
    expect(text).toContain('access denied');
    expect(text).toContain('下次连接');
  });

  it('保存成功时不出红条（不能无端吓人）', async () => {
    mocks.hasPassword.mockResolvedValue(false);

    render();
    await click('生产机');
    const asked = mocks.prompt.mock.calls[0][0] as {
      onSubmit: (password: string) => Promise<void>;
    };
    await act(async () => {
      await asked.onSubmit('pw');
    });

    expect(mocks.savePassword).toHaveBeenCalledWith('c1', 'pw');
    expect(document.body.textContent ?? '').not.toContain('没能保存到本设备');
  });
});
