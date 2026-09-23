// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SavedConnection } from '@/lib/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** Modal 用它量高度；jsdom 不实现。 */
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
      fetchConnections: vi.fn(),
      addConnection: vi.fn(),
      removeConnection: vi.fn(),
      applyConnectionOrder: vi.fn(),
      activeConnectionId: null,
      setActiveConnection: vi.fn(),
      error: null,
    }),
}));

vi.mock('@/stores/sessionStore', () => ({
  useSessionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      connect: mocks.connect,
      connectWithSavedPassword: mocks.connectWithSavedPassword,
      connectWithSavedPassphrase: mocks.connectWithSavedPassphrase,
    }),
}));

vi.mock('@/hooks/useSessionLifecycle', () => ({
  useSessionLifecycle: () => ({ onConnected: vi.fn(), onDisconnected: vi.fn() }),
}));

vi.mock('@/hooks/useConnectWithPassword', () => ({
  useConnectWithPassword: () => ({ prompt: mocks.prompt, dismiss: vi.fn(), Prompt: null }),
}));

vi.mock('@/hooks/useHostKeyMismatch', () => ({
  useHostKeyMismatch: () => ({ prompt: vi.fn(), Modal: null }),
}));

vi.mock('@/hooks/usePrivacyMode', () => ({ usePrivacyMode: () => mocks.privacy }));

// 表单与本组测试无关（新建/编辑连接是另一条路），渲染它只会把密钥库等依赖拖进来。
vi.mock('@/components/connection/ConnectionForm', () => ({ default: () => null }));

import ConnectionList from './ConnectionList';

const PW_CONN: SavedConnection = {
  id: 'c1',
  name: '生产机',
  host: '10.0.0.1',
  port: 22,
  username: 'root',
  authMethod: 'Password',
};

const KEY_CONN: SavedConnection = {
  id: 'c2',
  name: '密钥机',
  host: '10.0.0.2',
  port: 2222,
  username: 'deploy',
  authMethod: 'PrivateKey',
  keyId: 'k1',
};

let container: HTMLDivElement;
let root: Root;

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<ConnectionList />);
  });
}

/** 连接行的点击（行是列表里唯一带 data-conn-id 的按钮）。 */
async function clickRow(name: string) {
  const row = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-conn-id]')).find(
    (el) => el.textContent?.includes(name),
  );
  if (!row) throw new Error(`找不到连接行：${name}`);
  await act(async () => {
    row.click();
  });
  // handleConnect 是 async 且由 onClick 直接调用，多让出一拍把 catch 走完
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
  mocks.savePassphrase.mockResolvedValue(undefined);
  mocks.hasPassword.mockResolvedValue(true);
  mocks.hasPassphrase.mockResolvedValue(true);
  mocks.listKeys.mockResolvedValue([]);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = '';
});

/**
 * 密钥链里存着的那份密码被服务器拒了——必须**重新追问**，不能把这份打错一个字符的
 * 密码一路重放下去（每个连接都重放、每个「重连」也重放，用户永远等不到输入框）。
 *
 * 判据只认后端的原因码（`data.code === 'rejected'`），不认中文文案；`rejected` 在密码
 * 流程里的意思就是"这份密码被拒"（见 `src/lib/privateKey.ts`）。
 */
describe('已保存密码被拒后重新追问', () => {
  it('服务器拒绝密码时重新弹出密码框，并说明这次是"换一份"', async () => {
    mocks.connectWithSavedPassword.mockRejectedValue(keyAuthError('rejected'));

    render();
    await clickRow('生产机');

    expect(mocks.connectWithSavedPassword).toHaveBeenCalledTimes(1);
    expect(mocks.prompt).toHaveBeenCalledTimes(1);
    const asked = mocks.prompt.mock.calls[0][0] as { title: string; description: string };
    expect(asked.title).toBe('SSH 密码');
    expect(asked.description).toContain('上次保存的密码被服务器拒绝');
    expect(asked.description).toContain('root@10.0.0.1:22');
  });

  it('复问时输入的新密码会覆盖密钥链里那份错的，并用它去连', async () => {
    mocks.connectWithSavedPassword.mockRejectedValue(keyAuthError('rejected'));

    render();
    await clickRow('生产机');
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

  it('别的原因（网络不通等）不追问密码——用户照着提示也做不对下一步', async () => {
    mocks.connectWithSavedPassword.mockRejectedValue({
      kind: 'Ssh',
      message: 'SSH error: 连接失败: Network is unreachable',
    });

    render();
    await clickRow('生产机');

    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(mocks.savePassword).not.toHaveBeenCalled();
  });

  it('同一种 kind 但原因码是别的（缺密码 / 私钥那几档）也不追问', async () => {
    mocks.connectWithSavedPassword.mockRejectedValue(keyAuthError('key_missing_from_store'));

    render();
    await clickRow('生产机');

    expect(mocks.prompt).not.toHaveBeenCalled();
  });
});

/**
 * 两处密码框的文案都过 `formatConnLabel`（隐私模式下 `***:****`）——浮层最容易漏，
 * 它是写在字符串里而不是渲染在 JSX 里的。
 */
describe('密码框文案走隐私模式口径', () => {
  it('密码框：隐私模式下不出现真实主机与端口', async () => {
    mocks.privacy = true;
    mocks.connectWithSavedPassword.mockRejectedValue(keyAuthError('rejected'));

    render();
    await clickRow('生产机');

    const asked = mocks.prompt.mock.calls[0][0] as { description: string };
    expect(asked.description).toContain('root@***:****');
    expect(asked.description).not.toContain('10.0.0.1');
    expect(asked.description).not.toContain(':22');
  });

  it('私钥密码框：隐私模式下同样不出现真实主机与端口', async () => {
    mocks.privacy = true;
    mocks.connections = [KEY_CONN];
    mocks.connectWithSavedPassphrase.mockRejectedValue(
      keyAuthError('bad_passphrase', '私钥密码不正确'),
    );

    render();
    await clickRow('密钥机');

    expect(mocks.prompt).toHaveBeenCalledTimes(1);
    const asked = mocks.prompt.mock.calls[0][0] as { title: string; description: string };
    expect(asked.title).toBe('私钥密码');
    expect(asked.description).toContain('deploy@***:****');
    expect(asked.description).not.toContain('10.0.0.2');
    expect(asked.description).not.toContain('2222');
  });

  it('非隐私模式下照实显示 user@host:port', async () => {
    mocks.connections = [KEY_CONN];
    mocks.connectWithSavedPassphrase.mockRejectedValue(
      keyAuthError('bad_passphrase', '私钥密码不正确'),
    );

    render();
    await clickRow('密钥机');

    const asked = mocks.prompt.mock.calls[0][0] as { description: string };
    expect(asked.description).toContain('deploy@10.0.0.2:2222');
  });
});

/**
 * 密钥链写入失败必须出声。
 *
 * 保存失败**不拦连接**（密钥链不可用时照样把这次连接连上，既有取舍），但用户不能
 * 被留在"连上了"的表象里——那份密码根本没记住，下次连接与「重连」还会再要一次。
 * 以前这里静默吞掉，用户以为自己早就存过了。
 */
describe('密钥链写入失败要出声', () => {
  function alertText(): string {
    // 本地错误红条（连接列表页顶部的 role="alert"）
    return document.querySelector('[role="alert"]')?.textContent ?? '';
  }

  it('密码没能保存：连接照常进行，红条说明这次没记住', async () => {
    mocks.hasPassword.mockResolvedValue(false);
    mocks.savePassword.mockRejectedValue({
      kind: 'Config',
      message: '保存密码到密钥链失败：access denied',
    });

    render();
    await clickRow('生产机');
    const asked = mocks.prompt.mock.calls[0][0] as {
      onSubmit: (password: string) => Promise<void>;
    };
    await act(async () => {
      await asked.onSubmit('pw');
    });

    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(alertText()).toContain('access denied');
    expect(alertText()).toContain('下次连接');
  });

  it('密钥密码没能保存：同样出声', async () => {
    mocks.connections = [KEY_CONN];
    mocks.connectWithSavedPassphrase.mockRejectedValue(keyAuthError('bad_passphrase'));
    mocks.savePassphrase.mockRejectedValue({
      kind: 'Config',
      message: '保存密码到密钥链失败：access denied',
    });

    render();
    await clickRow('密钥机');
    const asked = mocks.prompt.mock.calls[0][0] as {
      onSubmit: (passphrase: string) => Promise<void>;
    };
    await act(async () => {
      await asked.onSubmit('key-pass');
    });

    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(alertText()).toContain('access denied');
  });

  it('保存成功时不出红条（不能无端吓人）', async () => {
    mocks.hasPassword.mockResolvedValue(false);

    render();
    await clickRow('生产机');
    const asked = mocks.prompt.mock.calls[0][0] as {
      onSubmit: (password: string) => Promise<void>;
    };
    await act(async () => {
      await asked.onSubmit('pw');
    });

    expect(mocks.savePassword).toHaveBeenCalledWith('c1', 'pw');
    expect(alertText()).toBe('');
  });
});
