import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMarketStore, MARKET_DEFAULT_SOURCE } from '@/stores/marketStore';
import type { MarketIndex } from '@/lib/types';

const { marketListMock } = vi.hoisted(() => ({
  marketListMock: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({
  marketList: marketListMock,
}));

// Node 测试环境无 localStorage —— 提供内存 stub（store 本身有 try/catch 兜底，
// 这里主要是为了测试断言能读）。
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
    clear: () => storage.clear(),
  },
  configurable: true,
});

function makeIndex(ids: string[]): MarketIndex {
  return {
    generatedAt: '2026-08-02T00:00:00Z',
    plugins: ids.map((id) => ({
      id,
      name: id,
      version: '1.0.0',
      publisher: '',
      description: '',
      capabilities: [],
      category: 'other',
      icon: null,
      repoUrl: `https://github.com/x/${id}`,
      updatedAt: '2026-08-02',
    })),
  };
}

describe('marketStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useMarketStore.setState({ plugins: [], loading: false, error: null, loadedAt: null, sourceUrl: '' });
  });

  it('fetches the index and stores plugins', async () => {
    marketListMock.mockResolvedValueOnce(makeIndex(['a', 'b']));
    await useMarketStore.getState().fetch();
    expect(marketListMock).toHaveBeenCalledWith(undefined);
    expect(useMarketStore.getState().plugins).toHaveLength(2);
    expect(useMarketStore.getState().error).toBeNull();
    expect(useMarketStore.getState().loadedAt).not.toBeNull();
  });

  it('passes a custom source URL when set', async () => {
    useMarketStore.getState().setSource('https://mirror.example.com/index.json');
    marketListMock.mockResolvedValueOnce(makeIndex(['a']));
    await useMarketStore.getState().fetch();
    expect(marketListMock).toHaveBeenCalledWith('https://mirror.example.com/index.json');
  });

  it('persists custom source in localStorage', () => {
    useMarketStore.getState().setSource('https://mirror.example.com/index.json');
    expect(localStorage.getItem('marcel.market.source')).toBe('https://mirror.example.com/index.json');
  });

  it('clearing source falls back to the built-in official source', () => {
    useMarketStore.getState().setSource('https://mirror.example.com/index.json');
    useMarketStore.getState().setSource('');
    expect(localStorage.getItem('marcel.market.source')).toBeNull();
    expect(useMarketStore.getState().sourceUrl).toBe('');
    expect(MARKET_DEFAULT_SOURCE).toContain('cdn.jsdelivr.net');
  });

  it('records a readable error when the fetch fails', async () => {
    marketListMock.mockRejectedValueOnce('网络错误');
    await useMarketStore.getState().fetch();
    expect(useMarketStore.getState().error).toBe('网络错误');
    expect(useMarketStore.getState().loading).toBe(false);
  });
});
