// @vitest-environment jsdom
/**
 * 标签栏「重连」遇到"存的那份密码被服务器拒了"时的处理。
 *
 * 这个场景以前是一条死路：`ssh_reconnect` 每次都从密钥链取回**同一份**密码重放，
 * 用户点多少次「重连」都是同一个结果，界面上却只有一句 console.error——既没有解释，
 * 也没有换一份的入口。这一组钉住就地复问这条路：
 *  1. 认得出「密码被拒」→ 弹密码框，新密码覆盖密钥链里那份错的，再重连一次；
 *  2. 同一个原因码在私钥流程里表示"这把密钥被拒"→ **不许**追问密码；
 *  3. 拿不到连接记录（已被删 / 列表未载入）→ 说清去处，而不是默默失败；
 *  4. 新密码没进密钥链 → 不假装成功再重连一次（重连只会继续重放旧密码）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SavedConnection, Session } from '@/lib/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  savePassword: vi.fn(),
  reconnect: vi.fn(),
  prompt: vi.fn(),
  privacy: false,
  sessions: {} as Record<string, Session>,
  connections: [] as SavedConnection[],
}));

vi.mock('@/lib/tauri', () => ({ savePassword: mocks.savePassword }));

vi.mock('@/stores/sessionStore', () => ({
  useSessionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      sessions: mocks.sessions,
      activeSessionId: 's1',
      setActiveSession: vi.fn(),
      disconnect: vi.fn(),
      reconnect: mocks.reconnect,
    }),
}));

vi.mock('@/stores/connectionStore', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ connections: mocks.connections }),
}));

vi.mock('@/stores/taskStore', () => ({
  useTaskStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ tasks: {}, unreadCompletedConversations: [] }),
}));

vi.mock('@/hooks/useSessionLifecycle', () => ({
  useSessionLifecycle: () => ({ onDisconnected: vi.fn() }),
}));

vi.mock('@/hooks/useHostKeyMismatch', () => ({
  useHostKeyMismatch: () => ({ prompt: vi.fn(), Modal: null }),
}));

vi.mock('@/hooks/useConnectWithPassword', () => ({
  useConnectWithPassword: () => ({ prompt: mocks.prompt, dismiss: vi.fn(), Prompt: null }),
}));

vi.mock('@/hooks/usePrivacyMode', () => ({ usePrivacyMode: () => mocks.privacy }));

import TabBar from './TabBar';

const PW_CONN: SavedConnection = {
  id: 'c1',
  name: '生产机',
  host: '10.0.0.1',
  port: 22,
  username: 'root',
  authMethod: 'Password',
};

const KEY_CONN: SavedConnection = { ...PW_CONN, id: 'c1', authMethod: 'PrivateKey', keyId: 'k1' };

/** 断开的会话：只有这种状态才出现「重连」按钮。 */
const FAILED_SESSION: Session = {
  id: 's1',
  connectionId: 'root@10.0.0.1:22',
  status: 'error',
  createdAt: '2026-01-01T00:00:00Z',
  configId: 'c1',
};

let container: HTMLDivElement;
let root: Root;

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<TabBar />);
  });
}

/** 后端「服务器拒绝了这份凭据」的唯一线上形态：kind=KeyAuth + data.code。 */
function keyAuthError(code: string, message = '认证失败：用户名或密码错误') {
  return { kind: 'KeyAuth', message, data: { code } };
}

async function clickReconnect() {
  const button = document.querySelector<HTMLButtonElement>('button[title="重新连接"]');
  if (!button) throw new Error('找不到「重连」按钮');
  await act(async () => {
    button.click();
  });
  await act(async () => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.privacy = false;
  mocks.sessions = { s1: FAILED_SESSION };
  mocks.connections = [PW_CONN];
  mocks.reconnect.mockResolvedValue(undefined);
  mocks.savePassword.mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = '';
});

describe('重连：存的那份密码被拒后换一份', () => {
  it('弹密码框说明"换一份"，并给出脱敏后的连接称谓', async () => {
    mocks.reconnect.mockRejectedValue(keyAuthError('rejected'));

    render();
    await clickReconnect();

    expect(mocks.prompt).toHaveBeenCalledTimes(1);
    const asked = mocks.prompt.mock.calls[0][0] as { title: string; description: string };
    expect(asked.title).toBe('SSH 密码');
    expect(asked.description).toContain('上次保存的密码被服务器拒绝');
    expect(asked.description).toContain('root@10.0.0.1:22');
  });

  it('输入的新密码覆盖密钥链里那份错的，然后重连', async () => {
    mocks.reconnect.mockRejectedValueOnce(keyAuthError('rejected'));

    render();
    await clickReconnect();
    const asked = mocks.prompt.mock.calls[0][0] as {
      onSubmit: (password: string) => Promise<void>;
    };
    await act(async () => {
      await asked.onSubmit('正确的密码');
    });

    expect(mocks.savePassword).toHaveBeenCalledWith('c1', '正确的密码');
    // 第一次是用户点的、第二次是覆盖成功后自动再来一遍
    expect(mocks.reconnect).toHaveBeenCalledTimes(2);
  });

  it('隐私模式下密码框不出现真实主机与端口', async () => {
    mocks.privacy = true;
    mocks.reconnect.mockRejectedValue(keyAuthError('rejected'));

    render();
    await clickReconnect();

    const asked = mocks.prompt.mock.calls[0][0] as { description: string };
    expect(asked.description).toContain('root@***:****');
    expect(asked.description).not.toContain('10.0.0.1');
  });

  it('弹过框就不再留红条（同一件事不说两遍）', async () => {
    mocks.reconnect.mockRejectedValue(keyAuthError('rejected'));

    render();
    await clickReconnect();

    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('重连：不该追问密码的情形', () => {
  it('私钥被拒时不追问密码（同一个原因码在两个流程里意义不同）', async () => {
    mocks.connections = [KEY_CONN];
    mocks.reconnect.mockRejectedValue(
      keyAuthError('rejected', '服务器拒绝了这把密钥'),
    );

    render();
    await clickReconnect();

    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(mocks.savePassword).not.toHaveBeenCalled();
    // 拿不到"这是密码流程"的依据时，只能把去处说清楚
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('连接列表');
  });

  it('拿不到连接记录（列表未载入 / 记录已删）时说清去处', async () => {
    mocks.connections = [];
    mocks.reconnect.mockRejectedValue(keyAuthError('rejected'));

    render();
    await clickReconnect();

    expect(mocks.prompt).not.toHaveBeenCalled();
    const notice = document.querySelector('[role="alert"]')?.textContent ?? '';
    expect(notice).toContain('连接列表');
    expect(notice).toContain('认证失败');
  });

  it('别的原因（网络不通）不追问密码、也不冒充其它提示', async () => {
    mocks.reconnect.mockRejectedValue({
      kind: 'Ssh',
      message: 'SSH error: 连接失败: Network is unreachable',
    });

    render();
    await clickReconnect();

    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('重连：新密码没进密钥链', () => {
  it('说出"没记住"并让用户去连接列表，而不是假装成功再重连一次', async () => {
    mocks.reconnect.mockRejectedValueOnce(keyAuthError('rejected'));
    mocks.savePassword.mockRejectedValue({
      kind: 'Config',
      message: '保存密码到密钥链失败：access denied',
    });

    render();
    await clickReconnect();
    const asked = mocks.prompt.mock.calls[0][0] as {
      onSubmit: (password: string) => Promise<void>;
    };
    await act(async () => {
      await asked.onSubmit('正确的密码');
    });

    // 只有用户点的那一次；重连只会继续重放旧密码，不能自动再试
    expect(mocks.reconnect).toHaveBeenCalledTimes(1);
    const notice = document.querySelector('[role="alert"]')?.textContent ?? '';
    expect(notice).toContain('access denied');
    expect(notice).toContain('连接列表');
  });
});
