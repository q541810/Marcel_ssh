import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useMcpStore } from '@/stores/mcpStore';
import type { McpServer, McpServerListResponse, McpServerRuntimeStatus } from '@/lib/types';

const MOCK_SERVER: McpServer = {
  id: 's1',
  name: 'Test MCP',
  url: 'https://example.com/mcp',
  headers: { Authorization: 'Bearer token' },
  enabled: true,
  trusted: false,
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
};

const MOCK_STATUS: McpServerRuntimeStatus = {
  serverId: 's1',
  tools: [{ name: 'read', description: 'Read file', inputSchema: {} }],
  error: null,
  discovered: true,
};

const MOCK_RESPONSE: McpServerListResponse = {
  servers: [MOCK_SERVER],
  statuses: [MOCK_STATUS],
};

const {
  mcpListServers,
  mcpAddServer,
  mcpUpdateServer,
  mcpDeleteServer,
  mcpToggleServer,
  mcpRefreshTools,
} = vi.hoisted(() => ({
  mcpListServers: vi.fn(),
  mcpAddServer: vi.fn(),
  mcpUpdateServer: vi.fn(),
  mcpDeleteServer: vi.fn(),
  mcpToggleServer: vi.fn(),
  mcpRefreshTools: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({
  mcpListServers,
  mcpAddServer,
  mcpUpdateServer,
  mcpDeleteServer,
  mcpToggleServer,
  mcpRefreshTools,
}));

describe('mcpStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMcpStore.setState({
      servers: [],
      statuses: {},
      loading: false,
      refreshingIds: {},
      error: null,
    });
  });

  it('initial state is empty', () => {
    const s = useMcpStore.getState();
    expect(s.servers).toEqual([]);
    expect(s.statuses).toEqual({});
    expect(s.loading).toBe(false);
    expect(s.refreshingIds).toEqual({});
    expect(s.error).toBeNull();
  });

  describe('fetchServers', () => {
    it('populates servers and statuses on success', async () => {
      mcpListServers.mockResolvedValue(MOCK_RESPONSE);

      await useMcpStore.getState().fetchServers();

      const s = useMcpStore.getState();
      expect(s.servers).toHaveLength(1);
      expect(s.servers[0].name).toBe('Test MCP');
      expect(s.statuses['s1']).toBeDefined();
      expect(s.statuses['s1'].tools).toHaveLength(1);
      expect(s.statuses['s1'].discovered).toBe(true);
      expect(s.loading).toBe(false);
      expect(s.error).toBeNull();
    });

    it('sets loading during non-silent fetch', async () => {
      let resolveList: (v: McpServerListResponse) => void;
      mcpListServers.mockReturnValue(new Promise((r) => { resolveList = r; }));

      const p = useMcpStore.getState().fetchServers();
      expect(useMcpStore.getState().loading).toBe(true);

      resolveList!(MOCK_RESPONSE);
      await p;
      expect(useMcpStore.getState().loading).toBe(false);
    });

    it('silent fetch does not toggle loading', async () => {
      mcpListServers.mockResolvedValue(MOCK_RESPONSE);
      useMcpStore.setState({ loading: false });

      await useMcpStore.getState().fetchServers({ silent: true });

      expect(useMcpStore.getState().loading).toBe(false);
      expect(useMcpStore.getState().servers).toHaveLength(1);
    });

    it('sets error on failure', async () => {
      mcpListServers.mockRejectedValue(new Error('network error'));

      await useMcpStore.getState().fetchServers();

      const s = useMcpStore.getState();
      expect(s.error).toBe('network error');
      expect(s.loading).toBe(false);
    });
  });

  describe('addServer', () => {
    it('calls tauri add then fetches and refreshes when enabled', async () => {
      const newServer: McpServer = { ...MOCK_SERVER, id: 'new', name: 'New' };
      mcpAddServer.mockResolvedValue(newServer);
      mcpListServers.mockResolvedValue({ servers: [newServer], statuses: [] });
      mcpRefreshTools.mockResolvedValue([]);

      const input = { name: 'New', url: 'https://x.com', headers: {}, enabled: true, trusted: false };
      await useMcpStore.getState().addServer(input);

      expect(mcpAddServer).toHaveBeenCalledWith(input);
      expect(mcpListServers).toHaveBeenCalled();
      expect(mcpRefreshTools).toHaveBeenCalledWith('new');
      expect(useMcpStore.getState().loading).toBe(false);
    });

    it('does not refresh when added disabled', async () => {
      const newServer: McpServer = { ...MOCK_SERVER, id: 'new', name: 'New', enabled: false };
      mcpAddServer.mockResolvedValue(newServer);
      mcpListServers.mockResolvedValue({ servers: [newServer], statuses: [] });

      const input = { name: 'New', url: 'https://x.com', headers: {}, enabled: false, trusted: false };
      await useMcpStore.getState().addServer(input);

      expect(mcpRefreshTools).not.toHaveBeenCalled();
    });

    it('does not set global loading during mutation', async () => {
      const newServer: McpServer = { ...MOCK_SERVER, id: 'new', name: 'New' };
      let resolveAdd: (v: McpServer) => void;
      mcpAddServer.mockReturnValue(new Promise((r) => { resolveAdd = r; }));
      mcpListServers.mockResolvedValue({ servers: [newServer], statuses: [] });
      mcpRefreshTools.mockResolvedValue([]);

      const p = useMcpStore.getState().addServer({
        name: 'New', url: 'https://x.com', headers: {}, enabled: true, trusted: false,
      });
      expect(useMcpStore.getState().loading).toBe(false);

      resolveAdd!(newServer);
      await p;
      expect(useMcpStore.getState().loading).toBe(false);
    });

    it('propagates error from tauri', async () => {
      mcpAddServer.mockRejectedValue(new Error('duplicate'));
      const input = { name: 'x', url: 'https://x.com', headers: {}, enabled: true, trusted: false };

      await expect(useMcpStore.getState().addServer(input)).rejects.toThrow('duplicate');
      expect(useMcpStore.getState().error).toBe('duplicate');
    });
  });

  describe('updateServer', () => {
    it('calls tauri update then fetches and refreshes when enabled', async () => {
      mcpUpdateServer.mockResolvedValue(undefined);
      mcpListServers.mockResolvedValue(MOCK_RESPONSE);
      mcpRefreshTools.mockResolvedValue([]);

      const input = { name: 'Updated', url: 'https://y.com', headers: {}, enabled: true, trusted: true };
      await useMcpStore.getState().updateServer('s1', input);

      expect(mcpUpdateServer).toHaveBeenCalledWith('s1', input);
      expect(mcpListServers).toHaveBeenCalled();
      expect(mcpRefreshTools).toHaveBeenCalledWith('s1');
      expect(useMcpStore.getState().loading).toBe(false);
    });

    it('does not refresh when updated to disabled', async () => {
      mcpUpdateServer.mockResolvedValue(undefined);
      mcpListServers.mockResolvedValue(MOCK_RESPONSE);

      const input = { name: 'Updated', url: 'https://y.com', headers: {}, enabled: false, trusted: true };
      await useMcpStore.getState().updateServer('s1', input);

      expect(mcpRefreshTools).not.toHaveBeenCalled();
    });
  });

  describe('deleteServer', () => {
    it('calls tauri delete then fetches', async () => {
      mcpDeleteServer.mockResolvedValue(undefined);
      mcpListServers.mockResolvedValue(MOCK_RESPONSE);

      await useMcpStore.getState().deleteServer('s1');

      expect(mcpDeleteServer).toHaveBeenCalledWith('s1');
      expect(mcpListServers).toHaveBeenCalled();
      expect(useMcpStore.getState().loading).toBe(false);
    });

    it('sets error on failure and still refetches', async () => {
      mcpDeleteServer.mockRejectedValue(new Error('gone'));
      mcpListServers.mockResolvedValue(MOCK_RESPONSE);

      await useMcpStore.getState().deleteServer('s1');

      expect(mcpListServers).toHaveBeenCalled();
      expect(useMcpStore.getState().error).toBe('gone');
    });
  });

  describe('toggleServer', () => {
    it('optimistically flips enabled and keeps tools cache status', async () => {
      useMcpStore.setState({
        servers: [MOCK_SERVER],
        statuses: { s1: MOCK_STATUS },
      });
      mcpToggleServer.mockResolvedValue(undefined);

      let resolveFetch: (v: McpServerListResponse) => void;
      mcpListServers.mockReturnValue(
        new Promise((r) => { resolveFetch = r; }),
      );

      const togglePromise = useMcpStore.getState().toggleServer('s1');

      const mid = useMcpStore.getState();
      expect(mid.servers[0].enabled).toBe(false);
      // Cache status is not cleared on toggle — tools remain visible
      expect(mid.statuses['s1'].discovered).toBe(true);
      expect(mid.statuses['s1'].tools).toHaveLength(1);
      expect(mid.loading).toBe(false);

      resolveFetch!({
        servers: [{ ...MOCK_SERVER, enabled: false }],
        statuses: [MOCK_STATUS],
      });
      await togglePromise;

      expect(mcpRefreshTools).not.toHaveBeenCalled();
    });

    it('refreshes tools when toggled on', async () => {
      const disabled = { ...MOCK_SERVER, enabled: false };
      useMcpStore.setState({
        servers: [disabled],
        statuses: { s1: MOCK_STATUS },
      });
      mcpToggleServer.mockResolvedValue(undefined);
      mcpListServers.mockResolvedValue({
        servers: [MOCK_SERVER],
        statuses: [MOCK_STATUS],
      });
      mcpRefreshTools.mockResolvedValue([]);

      await useMcpStore.getState().toggleServer('s1');

      expect(mcpToggleServer).toHaveBeenCalledWith('s1');
      expect(mcpRefreshTools).toHaveBeenCalledWith('s1');
    });

    it('supplies error on tauri failure after fetchServers', async () => {
      useMcpStore.setState({ servers: [MOCK_SERVER] });
      mcpToggleServer.mockRejectedValue(new Error('offline'));
      mcpListServers.mockResolvedValue(MOCK_RESPONSE);

      await useMcpStore.getState().toggleServer('s1');

      expect(mcpListServers).toHaveBeenCalled();
      expect(useMcpStore.getState().error).toBe('offline');
    });
  });

  describe('refreshTools', () => {
    it('calls tauri refresh then silent fetches', async () => {
      mcpRefreshTools.mockResolvedValue([]);
      mcpListServers.mockResolvedValue(MOCK_RESPONSE);

      await useMcpStore.getState().refreshTools('s1');

      expect(mcpRefreshTools).toHaveBeenCalledWith('s1');
      expect(mcpListServers).toHaveBeenCalled();
      expect(useMcpStore.getState().refreshingIds['s1']).toBeUndefined();
      expect(useMcpStore.getState().loading).toBe(false);
    });

    it('sets error on failure but still fetches', async () => {
      mcpRefreshTools.mockRejectedValue(new Error('timeout'));
      mcpListServers.mockResolvedValue(MOCK_RESPONSE);

      await useMcpStore.getState().refreshTools('s1');

      expect(useMcpStore.getState().error).toBe('timeout');
      expect(useMcpStore.getState().refreshingIds['s1']).toBeUndefined();
    });

    it('skips concurrent refresh for same id', async () => {
      let resolveRefresh: (v: unknown) => void;
      mcpRefreshTools.mockReturnValue(new Promise((r) => { resolveRefresh = r; }));
      mcpListServers.mockResolvedValue(MOCK_RESPONSE);

      const first = useMcpStore.getState().refreshTools('s1');
      expect(useMcpStore.getState().refreshingIds['s1']).toBe(true);

      await useMcpStore.getState().refreshTools('s1');
      expect(mcpRefreshTools).toHaveBeenCalledTimes(1);

      resolveRefresh!([]);
      await first;
    });
  });
});
