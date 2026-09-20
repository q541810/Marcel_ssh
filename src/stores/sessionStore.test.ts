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
import { terminalInstanceManager } from '@/components/terminal/TerminalInstanceManager';
import * as tauri from '@/lib/tauri';
import type { ConnectionConfig } from '@/lib/types';

const { sshConnect, connectWithSavedPassword, connectWithSavedPassphrase } =
  vi.hoisted(() => ({
    sshConnect: vi.fn(),
    connectWithSavedPassword: vi.fn(),
    connectWithSavedPassphrase: vi.fn(),
  }));

vi.mock('@/lib/tauri', () => ({
  sshConnect,
  connectWithSavedPassword,
  connectWithSavedPassphrase,
  sshDisconnect: vi.fn(),
  // 连接成功后会拉一次会话快照做对齐，成功路径需要它
  sshListSessions: vi.fn().mockResolvedValue([]),
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

  describe('失败后重试不再攒出一摞同名标签', () => {
    it('重试同一条连接时复用那条失败会话，只留一个标签', async () => {
      sshConnect
        .mockRejectedValueOnce('第一次失败')
        .mockRejectedValueOnce('第二次失败');

      const config = { ...makeConfig(), connectionId: 'conn-1' };
      await expect(useSessionStore.getState().connect(config)).rejects.toBe(
        '第一次失败',
      );
      const firstId = useSessionStore.getState().activeSessionId;

      await expect(useSessionStore.getState().connect(config)).rejects.toBe(
        '第二次失败',
      );
      const { sessions, activeSessionId } = useSessionStore.getState();

      expect(Object.keys(sessions)).toHaveLength(1);
      expect(activeSessionId).toBe(firstId);
      // 复用槽位也要把新的失败原因带上，否则用户看到的是上一次的原因
      expect(sessions[firstId!].errorMessage).toBe('第二次失败');
    });

    it('复用失败槽位时清掉"横幅已显示"标记（否则第二次失败在终端里什么都不显示）', async () => {
      sshConnect.mockRejectedValue('失败');
      const config = { ...makeConfig(), connectionId: 'conn-1' };

      await expect(useSessionStore.getState().connect(config)).rejects.toBe('失败');
      const firstId = useSessionStore.getState().activeSessionId;
      await expect(useSessionStore.getState().connect(config)).rejects.toBe('失败');

      // 第一次是新建槽位，第二次才是复用；复用必须触发一次 prepareReconnect
      expect(vi.mocked(terminalInstanceManager.prepareReconnect)).toHaveBeenCalledWith(
        firstId,
      );
    });

    it('不同连接的失败各自留一个标签，不会互相顶掉', async () => {
      sshConnect.mockRejectedValue('失败');

      await expect(
        useSessionStore.getState().connect({ ...makeConfig(), connectionId: 'conn-1' }),
      ).rejects.toBe('失败');
      await expect(
        useSessionStore.getState().connect({ ...makeConfig(), connectionId: 'conn-2' }),
      ).rejects.toBe('失败');

      const { sessions } = useSessionStore.getState();
      expect(Object.keys(sessions)).toHaveLength(2);
    });

    it('手动保存凭证的连接（拿到密钥密码后重试）同样复用槽位', async () => {
      connectWithSavedPassphrase
        .mockRejectedValueOnce('密码不对')
        .mockRejectedValueOnce('还是不对');

      await expect(
        useSessionStore
          .getState()
          .connectWithSavedPassphrase('conn-9', 'root@example.test:22'),
      ).rejects.toBe('密码不对');
      const firstId = useSessionStore.getState().activeSessionId;

      await expect(
        useSessionStore
          .getState()
          .connectWithSavedPassphrase('conn-9', 'root@example.test:22'),
      ).rejects.toBe('还是不对');

      const { sessions, activeSessionId } = useSessionStore.getState();
      expect(Object.keys(sessions)).toHaveLength(1);
      expect(activeSessionId).toBe(firstId);
    });

    it('连接成功后失败槽位被正式会话取代（不残留）', async () => {
      sshConnect.mockRejectedValueOnce('先失败');
      const config = { ...makeConfig(), connectionId: 'conn-1' };
      await expect(useSessionStore.getState().connect(config)).rejects.toBe('先失败');

      sshConnect.mockResolvedValueOnce('session-real');
      // 连接成功后会拉一次会话快照做对齐：后端要认得这个新会话
      vi.mocked(tauri.sshListSessions).mockResolvedValueOnce(['session-real']);
      await useSessionStore.getState().connect(config);

      const { sessions, activeSessionId } = useSessionStore.getState();
      expect(Object.keys(sessions)).toEqual(['session-real']);
      expect(activeSessionId).toBe('session-real');
      expect(sessions['session-real'].status).toBe('connected');
    });
  });
});
