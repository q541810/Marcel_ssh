import { useEffect, useState, useCallback } from 'react';
import { useMcpStore } from '@/stores/mcpStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { McpServer, McpServerInput } from '@/lib/types';
import ListPanel from '@/components/ui/ListPanel';
import ContextMenu from '@/components/ui/ContextMenu';
import Toggle from '@/components/ui/Toggle';
import McpServerModal from './McpServerModal';

export default function McpList() {
  const servers = useMcpStore((s) => s.servers);
  const statuses = useMcpStore((s) => s.statuses);
  const loading = useMcpStore((s) => s.loading);
  const refreshingIds = useMcpStore((s) => s.refreshingIds);
  const error = useMcpStore((s) => s.error);
  const fetchServers = useMcpStore((s) => s.fetchServers);
  const addServer = useMcpStore((s) => s.addServer);
  const updateServer = useMcpStore((s) => s.updateServer);
  const deleteServer = useMcpStore((s) => s.deleteServer);
  const toggleServer = useMcpStore((s) => s.toggleServer);
  const refreshTools = useMcpStore((s) => s.refreshTools);
  const confirmEachCommand = useSettingsStore((s) => s.settings.agentModeSettings.confirmEachCommand);

  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<McpServer | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; server: McpServer } | null>(null);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  useEffect(() => {
    fetchServers();
  }, [fetchServers]);

  const lowerQuery = query.toLowerCase();
  const filtered = servers.filter(
    (s) => s.name.toLowerCase().includes(lowerQuery) || s.url.toLowerCase().includes(lowerQuery),
  );
  const enabledCount = servers.filter((s) => s.enabled).length;

  const handleSave = async (input: McpServerInput) => {
    if (editing) {
      await updateServer(editing.id, input);
    } else {
      await addServer(input);
    }
  };

  const openCreate = () => {
    setEditing(null);
    setModalOpen(true);
  };

  const contextMenuItems = contextMenu
    ? [
        {
          label: '编辑',
          onClick: () => {
            setEditing(contextMenu.server);
            setModalOpen(true);
          },
        },
        { divider: true } as { label: string; onClick: () => void; variant?: 'default' | 'danger'; divider?: boolean },
        {
          label: '删除',
          variant: 'danger' as const,
          onClick: () => {
            if (confirm(`确定删除 "${contextMenu.server.name}" 吗？`)) {
              deleteServer(contextMenu.server.id);
            }
          },
        },
      ]
    : [];

  return (
    <ListPanel
      data-region="mcp"
      title="自定义 MCP"
      onAdd={openCreate}
      addButtonTitle="新建 MCP"
      searchQuery={query}
      onSearchChange={setQuery}
      searchPlaceholder="搜索 MCP..."
      status={
        (servers.length > 0 || error) ? (
          <>
            {servers.length > 0 && (
              <span>{servers.length} 个 MCP · {enabledCount} 个已启用</span>
            )}
            {error && <div className="mt-1 text-red-400">{error}</div>}
          </>
        ) : undefined
      }
    >
      <div className="space-y-1 text-sm">
        {loading && servers.length === 0 && (
          <p className="text-zinc-500 text-center mt-4">加载中...</p>
        )}
        {!loading && servers.length === 0 && (
          <div className="text-center mt-6 px-3">
            <p className="text-zinc-500 mb-3">尚未配置任何 MCP 服务器</p>
            <button
              onClick={openCreate}
              className="text-xs text-indigo-400 hover:text-indigo-300 underline"
            >
              创建 MCP
            </button>
          </div>
        )}
        {filtered.map((server) => {
          const status = statuses[server.id];
          const tools = status?.tools ?? [];
          const discovered = status?.discovered === true;
          const refreshing = !!refreshingIds[server.id];
          const subtitle = server.url || '';
          return (
            <div
              key={server.id}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, server });
              }}
              className={
                'group rounded-lg border transition-colors px-2 py-2 space-y-2 ' +
                (server.enabled
                  ? 'bg-indigo-900/20 border-indigo-700/50 hover:border-indigo-700'
                  : 'bg-zinc-900/40 border-zinc-800 hover:border-zinc-700')
              }
            >
              <div className="flex items-center gap-2">
                <Toggle checked={server.enabled} onChange={() => toggleServer(server.id)} size="sm" />
                <button
                  onClick={() => setExpandedId(expandedId === server.id ? null : server.id)}
                  className="flex-1 min-w-0 text-left"
                >
                  <div className="text-zinc-200 font-medium truncate">{server.name}</div>
                  <div className="text-xs text-zinc-500 truncate">
                    {subtitle || <span className="italic text-zinc-600">未配置详情</span>}
                  </div>
                </button>
                <button
                  onClick={() => refreshTools(server.id)}
                  disabled={refreshing}
                  title="刷新工具"
                  className="flex-shrink-0 p-1 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 opacity-0 group-hover:opacity-100 transition-all disabled:opacity-50"
                >
                  <svg
                    className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                </button>
                <button
                  onClick={() => { setEditing(server); setModalOpen(true); }}
                  title="编辑"
                  className="flex-shrink-0 p-1 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 opacity-0 group-hover:opacity-100 transition-all"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                </button>
                <button
                  onClick={() => { if (confirm(`确定删除 "${server.name}" 吗？`)) deleteServer(server.id); }}
                  title="删除"
                  className="flex-shrink-0 p-1 rounded-md text-zinc-500 hover:text-red-400 hover:bg-zinc-800 opacity-0 group-hover:opacity-100 transition-all"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3" />
                  </svg>
                </button>
              </div>
              {status?.error && <div className="text-xs text-red-400 break-words">{status.error}</div>}
              {refreshing && !status?.error && (
                <div className="text-xs text-zinc-500">正在刷新工具…</div>
              )}
              {discovered && tools.length === 0 && !status?.error && !refreshing && (
                <div className="text-xs text-amber-400">未发现工具 — 点击刷新</div>
              )}
              {expandedId === server.id && (
                <div className="rounded-md bg-zinc-950/60 border border-zinc-800 p-2 text-xs text-zinc-400 space-y-1">
                  <div>
                    {discovered ? `${tools.length} 个工具` : '尚未刷新工具'}
                    {' · '}
                    {server.trusted ? '已信任' : '默认需审批'}
                  </div>
                  {confirmEachCommand && server.trusted && (
                    <p className="text-xs text-amber-400">已开启「每条都手动确认」，信任后仍需手动审批</p>
                  )}
                  {tools.map((tool) => (
                    <div key={tool.name} className="border-t border-zinc-800 pt-1 first:border-t-0 first:pt-0">
                      <div className="text-zinc-200 font-mono">{tool.name}</div>
                      {tool.description && <div className="text-zinc-500">{tool.description}</div>}
                    </div>
                  ))}
                  {discovered && tools.length === 0 && !status?.error && (
                    <div className="text-zinc-600">尚未发现工具，点击"刷新"。</div>
                  )}
                  {!discovered && !refreshing && (
                    <div className="text-zinc-600">尚未刷新，点击刷新以发现工具。</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {!loading && servers.length > 0 && filtered.length === 0 && (
          <p className="text-zinc-500 text-center mt-4">无匹配 MCP</p>
        )}
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={closeContextMenu}
        />
      )}

      <McpServerModal
        open={modalOpen}
        server={editing}
        onClose={() => { setModalOpen(false); setEditing(null); }}
        onSave={handleSave}
      />
    </ListPanel>
  );
}
