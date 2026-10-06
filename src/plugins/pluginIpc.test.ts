/**
 * pluginIpc 错误回传路径的回归测试。
 *
 * 仓库规范：Tauri command 失败时 reject 的是序列化对象 `{ kind, message }`
 * （见 src-tauri/src/error.rs），`String(err)` 会把插件收到的失败负载渲染成
 * "[object Object]"。这里驱动一条真实消息走完 `plugin-request` → dispatch →
 * `plugin-response-<id>` 回路，断言插件拿到的是 `message` 字段的可读文案。
 *
 * Mock 边界只放在数据来源（Tauri event/core API 与 zustand store），回路
 * 本体（initPluginIpc 的 listener、commandRegistry 分发、auth 三层校验、
 * getErrorMessage 格式化）全部走真实现。
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const eventApi = vi.hoisted(() => ({
  /** initPluginIpc 注册的全部监听（event → handler）。 */
  listeners: [] as Array<{ event: string; handler: (e: { payload: unknown }) => unknown }>,
  emit: vi.fn(async () => {}),
}));

const coreApi = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

/** auth.ts / commandRegistry.ts 读取的 store 数据快照（测试内可改写）。 */
const stores = vi.hoisted(() => ({
  manifests: [] as Array<{ id: string; capabilities: string[] }>,
  settings: {
    disabledPlugins: [] as string[],
    authorizedCapabilities: {} as Record<string, string[]>,
  },
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => unknown) => {
    eventApi.listeners.push({ event, handler });
    return () => {};
  }),
  emit: eventApi.emit,
}));

// pluginIpc / commandRegistry 的 invoke 直接来自 @tauri-apps/api/core，
// mock 它才能让后端命令按测试意图 reject。
vi.mock('@tauri-apps/api/core', () => ({
  invoke: coreApi.invoke,
}));

vi.mock('@/lib/tauri', () => ({
  // 活映射表（命令名 → 能力名，与 Rust plugin_capability_map 同构）；
  // auth 的静态 fallback 表按能力名建表，不含后端命令名，所以这里必须
  // 提供与生产一致的映射，否则后端命令会在 auth 层被拒
  pluginCapabilityMap: vi.fn(async () => ({
    ssh_list_sessions: 'ssh.list',
    'config.read': 'fs.read',
  })),
}));

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ settings: stores.settings }) },
}));

vi.mock('@/stores/pluginStore', () => ({
  usePluginStore: { getState: () => ({ manifests: stores.manifests }) },
}));

vi.mock('@/stores/sessionStore', () => ({
  useSessionStore: {
    getState: () => ({ sessions: {}, activeSessionId: null }),
    subscribe: () => () => {},
  },
}));

vi.mock('@/stores/connectionStore', () => ({
  useConnectionStore: { getState: () => ({ connections: [] }) },
}));

// 会话激活桥只做订阅副作用，与本测试无关
vi.mock('./ipc/sessionActiveBridge', () => ({
  initSessionActiveBridge: () => {},
}));

import { initPluginIpc } from './pluginIpc';

function requestHandler(): (e: { payload: unknown }) => Promise<void> {
  const entry = eventApi.listeners.find((l) => l.event === 'plugin-request');
  if (!entry) throw new Error('initPluginIpc did not register a plugin-request listener');
  return entry.handler as (e: { payload: unknown }) => Promise<void>;
}

beforeAll(async () => {
  stores.manifests = [{ id: 'test-plugin', capabilities: ['ssh.list', 'fs.read'] }];
  stores.settings = { disabledPlugins: [], authorizedCapabilities: {} };
  await initPluginIpc();
});

beforeEach(() => {
  coreApi.invoke.mockReset();
  eventApi.emit.mockClear();
});

describe('pluginIpc 错误回传', () => {
  it('后端命令 reject 结构化对象时，回传 message 字段而不是 "[object Object]"', async () => {
    coreApi.invoke.mockRejectedValue({ kind: 'IoError', message: '磁盘满了' });

    await requestHandler()({
      payload: { id: 'req-backend', pluginId: 'test-plugin', cmd: 'ssh_list_sessions', args: {} },
    });

    expect(coreApi.invoke).toHaveBeenCalledWith('ssh_list_sessions', {});
    expect(eventApi.emit).toHaveBeenCalledWith('plugin-response-req-backend', {
      ok: false,
      data: '磁盘满了',
    });
  });

  it('虚拟命令（config.read）的 promise 拒绝同样回传可读文案', async () => {
    coreApi.invoke.mockRejectedValue({ kind: 'IoError', message: '磁盘满了' });

    await requestHandler()({
      payload: { id: 'req-virtual', pluginId: 'test-plugin', cmd: 'config.read', args: {} },
    });

    // 虚拟命令返回的 promise 由 fire-and-forget 的 then/catch 收尾，handler
    // 本身先返回，等 emission 落地
    await vi.waitFor(() => {
      expect(eventApi.emit).toHaveBeenCalledWith('plugin-response-req-virtual', {
        ok: false,
        data: '磁盘满了',
      });
    });
  });

  it('reject 纯字符串时原样透传', async () => {
    coreApi.invoke.mockRejectedValue('网络断了');

    await requestHandler()({
      payload: { id: 'req-string', pluginId: 'test-plugin', cmd: 'ssh_list_sessions', args: {} },
    });

    expect(eventApi.emit).toHaveBeenCalledWith('plugin-response-req-string', {
      ok: false,
      data: '网络断了',
    });
  });

  it('成功路径不受影响：respond(true, result)', async () => {
    coreApi.invoke.mockResolvedValue(['sess-1']);

    await requestHandler()({
      payload: { id: 'req-ok', pluginId: 'test-plugin', cmd: 'ssh_list_sessions', args: {} },
    });

    expect(eventApi.emit).toHaveBeenCalledWith('plugin-response-req-ok', {
      ok: true,
      data: ['sess-1'],
    });
  });
});
