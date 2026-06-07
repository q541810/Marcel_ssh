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
      error: null,
    });
  });

  it('initial state is empty', () => {
    const s = useMcpStore.getState();
    expect(s.servers).toEqual([]);
    expect(s.statuses).toEqual({});
    expect(s.loading).toBe(false);
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
      expect(s.loading).toBe(false);
      expect(s.error).toBeNull();
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
    it('calls tauri add then fetches and refreshes', async () => {
      const newServer: McpServer = { ...MOCK_SERVER, id: 'new', name: 'New' };
      mcpAddServer.mockResolvedValue(newServer);
      mcpListServers.mockResolvedValue({ servers: [newServer], statuses: [] });
      mcpRefreshTools.mockResolvedValue([]);
      mcpListServers.mockClear();

      const input = { name: 'New', url: 'https://x.com', headers: {}, enabled: true, trusted: false };
      await useMcpStore.getState().addServer(input);

      expect(mcpAddServer).toHaveBeenCalledWith(input);
      expect(mcpListServers).toHaveBeenCalled();
      expect(mcpRefreshTools).toHaveBeenCalledWith('new');
    });

    it('propagates error from tauri', async () => {
      mcpAddServer.mockRejectedValue(new Error('duplicate'));
      const input = { name: 'x', url: 'https://x.com', headers: {}, enabled: true, trusted: false };

      await expect(useMcpStore.getState().addServer(input)).rejects.toThrow('duplicate');
    });
  });

  describe('updateServer', () => {
    it('calls tauri update then fetches', async () => {
      mcpUpdateServer.mockResolvedValue(undefined);
      mcpListServers.mockResolvedValue(MOCK_RESPONSE);

      const input = { name: 'Updated', url: 'https://y.com', headers: {}, enabled: false, trusted: true };
      await useMcpStore.getState().updateServer('s1', input);

      expect(mcpUpdateServer).toHaveBeenCalledWith('s1', input);
      expect(mcpListServers).toHaveBeenCalled();
    });
  });

  describe('deleteServer', () => {
    it('calls tauri delete then fetches', async () => {
      mcpDeleteServer.mockResolvedValue(undefined);
      mcpListServers.mockResolvedValue(MOCK_RESPONSE);

      await useMcpStore.getState().deleteServer('s1');

      expect(mcpDeleteServer).toHaveBeenCalledWith('s1');
      expect(mcpListServers).toHaveBeenCalled();
    });

    it('sets error on failure but still tries to fetch', async () => {
      mcpDeleteServer.mockRejectedValue(new Error('gone'));
      mcpListServers.mockResolvedValue(MOCK_RESPONSE);

      await useMcpStore.getState().deleteServer('s1');

      expect(useMcpStore.getState().error).toBe('gone');
    });
  });

  describe('toggleServer', () => {
    it('optimistically flips enabled before tauri call completes', async () => {
      useMcpStore.setState({ servers: [MOCK_SERVER] });
      mcpToggleServer.mockResolvedValue(undefined);

      // Delay fetchServers so we can observe optimistic state
      let resolveFetch: (v: McpServerListResponse) => void;
      mcpListServers.mockReturnValue(
        new Promise((r) => { resolveFetch = r; }),
      );

      const togglePromise = useMcpStore.getState().toggleServer('s1');

      // At this point the optimistic set has run, but fetchServers hasn't resolved yet
      expect(useMcpStore.getState().servers[0].enabled).toBe(!MOCK_SERVER.enabled);

      resolveFetch!(MOCK_RESPONSE);
      await togglePromise;
    });

    it('supplies error on tauri failure after fetchServers', async () => {
      useMcpStore.setState({ servers: [MOCK_SERVER] });
      mcpToggleServer.mockRejectedValue(new Error('offline'));
      mcpListServers.mockResolvedValue(MOCK_RESPONSE);

      await useMcpStore.getState().toggleServer('s1');

      expect(useMcpStore.getState().error).toBe('offline');
    });
  });

  describe('refreshTools', () => {
    it('calls tauri refresh then fetches', async () => {
      mcpRefreshTools.mockResolvedValue([]);
      mcpListServers.mockResolvedValue(MOCK_RESPONSE);

      await useMcpStore.getState().refreshTools('s1');

      expect(mcpRefreshTools).toHaveBeenCalledWith('s1');
      expect(mcpListServers).toHaveBeenCalled();
    });

    it('sets error on failure but still fetches', async () => {
      mcpRefreshTools.mockRejectedValue(new Error('timeout'));
      mcpListServers.mockResolvedValue(MOCK_RESPONSE);

      await useMcpStore.getState().refreshTools('s1');

      expect(useMcpStore.getState().error).toBe('timeout');
    });
  });
});
