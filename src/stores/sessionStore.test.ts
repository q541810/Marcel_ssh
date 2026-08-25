import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/terminal/TerminalInstanceManager', () => ({
  terminalInstanceManager: {
    prepareReconnect: vi.fn(),
    onReconnected: vi.fn(),
    showDisconnectBanner: vi.fn(),
    setStdinEnabled: vi.fn(),
  },
}));

import { useSessionStore } from '@/stores/sessionStore';
import type { ConnectionConfig } from '@/lib/types';

const { sshConnect, connectWithSavedPassword } = vi.hoisted(() => ({
  sshConnect: vi.fn(),
  connectWithSavedPassword: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({
  sshConnect,
  connectWithSavedPassword,
  sshDisconnect: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

function makeConfig(): ConnectionConfig {
  return {
    host: 'example.test',
    port: 22,
    username: 'root',
    authMethod: { type: 'Password', password: 'secret' },
  };
}

describe('sessionStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStore.setState({
      sessions: {},
      activeSessionId: null,
    });
  });

  it('keeps failed quick connection visible with its error message', async () => {
    sshConnect.mockRejectedValueOnce('连接失败: connection refused');

    await expect(useSessionStore.getState().connect(makeConfig())).rejects.toBe(
      '连接失败: connection refused',
    );

    const { activeSessionId, sessions } = useSessionStore.getState();
    expect(activeSessionId).toBeTruthy();
    expect(sessions[activeSessionId!]).toMatchObject({
      connectionId: 'root@example.test:22',
      status: 'error',
      errorMessage: '连接失败: connection refused',
    });
  });

  it('keeps failed saved-password connection visible with its error message', async () => {
    connectWithSavedPassword.mockRejectedValueOnce(new Error('认证失败：用户名或密码/密钥错误'));

    await expect(
      useSessionStore.getState().connectWithSavedPassword('conn-1', 'root@example.test:22'),
    ).rejects.toThrow('认证失败：用户名或密码/密钥错误');

    const { activeSessionId, sessions } = useSessionStore.getState();
    expect(activeSessionId).toBeTruthy();
    expect(sessions[activeSessionId!]).toMatchObject({
      connectionId: 'root@example.test:22',
      status: 'error',
      errorMessage: '认证失败：用户名或密码/密钥错误',
      configId: 'conn-1',
    });
  });
});
