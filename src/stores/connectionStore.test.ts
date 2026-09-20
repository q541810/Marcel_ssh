import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useConnectionStore } from '@/stores/connectionStore';
import * as tauri from '@/lib/tauri';
import type { SavedConnection } from '@/lib/types';

vi.mock('@/lib/tauri', () => ({
  getConnections: vi.fn(),
  saveConnection: vi.fn(),
  deleteConnection: vi.fn(),
  applyConnectionOrder: vi.fn(),
}));

function conn(id: string, group?: string): SavedConnection {
  return {
    id,
    name: id,
    host: '127.0.0.1',
    port: 22,
    username: 'root',
    authMethod: 'Agent',
    group,
  };
}

const ids = () => useConnectionStore.getState().connections.map((c) => c.id);

describe('connectionStore.applyConnectionOrder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConnectionStore.setState({ connections: [], activeConnectionId: null, error: null });
  });

  it('乐观更新：立刻按新顺序与分组改本地，同时落库', async () => {
    useConnectionStore.setState({ connections: [conn('a', 'prod'), conn('b', 'test')] });
    (tauri.applyConnectionOrder as any).mockResolvedValue(undefined);

    await useConnectionStore.getState().applyConnectionOrder([
      { id: 'b', group: 'test' },
      { id: 'a', group: 'prod' },
    ]);

    expect(ids()).toEqual(['b', 'a']);
    expect(tauri.applyConnectionOrder).toHaveBeenCalledWith([
      { id: 'b', group: 'test' },
      { id: 'a', group: 'prod' },
    ]);
  });

  it('跨组拖拽：本地分组跟着改（未分组 = undefined）', async () => {
    useConnectionStore.setState({ connections: [conn('a', 'prod'), conn('b')] });
    (tauri.applyConnectionOrder as any).mockResolvedValue(undefined);

    await useConnectionStore.getState().applyConnectionOrder([
      { id: 'a', group: null },
      { id: 'b', group: null },
    ]);

    const convs = useConnectionStore.getState().connections;
    expect(convs.find((c) => c.id === 'a')?.group).toBeUndefined();
    expect(ids()).toEqual(['a', 'b']);
  });

  it('请求里缺的连接按原相对顺序补到末尾（不丢连接）', async () => {
    useConnectionStore.setState({ connections: [conn('a'), conn('b'), conn('c')] });
    (tauri.applyConnectionOrder as any).mockResolvedValue(undefined);

    await useConnectionStore.getState().applyConnectionOrder([{ id: 'c', group: null }]);

    expect(ids()).toEqual(['c', 'a', 'b']);
  });

  it('落库失败时整体回滚并记错误', async () => {
    const before = [conn('a'), conn('b')];
    useConnectionStore.setState({ connections: before });
    (tauri.applyConnectionOrder as any).mockRejectedValue(new Error('boom'));

    await useConnectionStore.getState().applyConnectionOrder([
      { id: 'b', group: null },
      { id: 'a', group: null },
    ]);

    expect(ids()).toEqual(['a', 'b']);
    expect(useConnectionStore.getState().error).toBe('boom');
  });
});
