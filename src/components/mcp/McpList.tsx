import { useEffect, useState, useCallback } from 'react';
import { Pencil, RefreshCw, Server, Trash2 } from 'lucide-react';
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
      <div className="space-y-px text-body">
        {loading && servers.length === 0 && (
          <div className="space-y-2 px-1 mt-2" aria-label="加载中...">
            <div className="h-12 rounded-lg bg-state-soft animate-pulse" />
            <div className="h-12 rounded-lg bg-state-soft animate-pulse" />
            <div className="h-12 rounded-lg bg-state-soft animate-pulse" />
          </div>
        )}
        {!loading && servers.length === 0 && (
          <div className="text-center mt-6 px-3">
            <Server size={24} strokeWidth={1.5} className="mx-auto mb-2 text-fg-tertiary" />
            <p className="text-body text-fg-secondary mb-3">尚未配置任何 MCP 服务器</p>
            <button
              onClick={openCreate}
              className="text-meta text-indigo-400 hover:text-indigo-300 underline"
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
                'group rounded-lg px-2 py-2 space-y-2 transition-colors duration-120 hover:bg-state-soft' +
                (expandedId === server.id ? ' bg-state-soft' : '')
              }
            >
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setExpandedId(expandedId === server.id ? null : server.id)}
                  className="flex-1 min-w-0 text-left"
                >
                  <div className={`text-body font-medium truncate ${server.enabled ? 'text-fg' : 'text-fg-secondary'}`}>{server.name}</div>
                </button>
                <button
                  onClick={() => refreshTools(server.id)}
                  disabled={refreshing}
                  title="刷新工具"
                  className="flex-shrink-0 p-1 rounded-md text-fg-tertiary hover:text-fg hover:bg-state-mid opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-ring transition-[color,background-color,opacity] duration-120 disabled:opacity-50"
                >
                  <RefreshCw size={14} strokeWidth={1.5} className={refreshing ? 'animate-spin' : ''} />
                </button>
                <button
                  onClick={() => { setEditing(server); setModalOpen(true); }}
                  title="编辑"
                  className="flex-shrink-0 p-1 rounded-md text-fg-tertiary hover:text-fg hover:bg-state-mid opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-ring transition-[color,background-color,opacity] duration-120"
                >
                  <Pencil size={14} strokeWidth={1.5} />
                </button>
                <button
                  onClick={() => { if (confirm(`确定删除 "${server.name}" 吗？`)) deleteServer(server.id); }}
                  title="删除"
                  className="flex-shrink-0 p-1 rounded-md text-fg-tertiary hover:text-red-400 hover:bg-state-mid opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-ring transition-[color,background-color,opacity] duration-120"
                >
                  <Trash2 size={14} strokeWidth={1.5} />
                </button>
                <div className="flex-shrink-0 pt-0.5">
                  <Toggle checked={server.enabled} onChange={() => toggleServer(server.id)} size="sm" ariaLabel={server.enabled ? '停用' : '启用'} />
                </div>
              </div>
              <div
                onClick={() => setExpandedId(expandedId === server.id ? null : server.id)}
                className="-mt-1.5 text-meta text-fg-tertiary truncate cursor-pointer"
              >
                {subtitle || <span className="italic text-fg-disabled">未配置详情</span>}
              </div>
              {status?.error && <div className="text-meta text-red-400 break-words">{status.error}</div>}
              {refreshing && !status?.error && (
                <div className="text-meta text-fg-tertiary">正在刷新工具…</div>
              )}
              {discovered && tools.length === 0 && !status?.error && !refreshing && (
                <div className="text-meta text-amber-400">未发现工具 — 点击刷新</div>
              )}
              {expandedId === server.id && (
                <div className="rounded-md bg-surface-sunken/60 border border-edge-subtle p-2 text-meta text-fg-secondary space-y-1">
                  <div>
                    {discovered ? `${tools.length} 个工具` : '尚未刷新工具'}
                    {' · '}
                    {server.trusted ? '已信任' : '默认需审批'}
                  </div>
                  {confirmEachCommand && server.trusted && (
                    <p className="text-meta text-amber-400">命令确认方式是「每条都确认」，信任后仍需手动审批</p>
                  )}
                  {tools.map((tool) => (
                    <div key={tool.name} className="border-t border-edge-subtle pt-1 first:border-t-0 first:pt-0">
                      <div className="text-fg font-mono">{tool.name}</div>
                      {tool.description && <div className="text-fg-tertiary">{tool.description}</div>}
                    </div>
                  ))}
                  {discovered && tools.length === 0 && !status?.error && (
                    <div className="text-fg-disabled">尚未发现工具，点击"刷新"。</div>
                  )}
                  {!discovered && !refreshing && (
                    <div className="text-fg-disabled">尚未刷新，点击刷新以发现工具。</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {!loading && servers.length > 0 && filtered.length === 0 && (
          <p className="text-fg-tertiary text-center mt-4">无匹配 MCP</p>
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
