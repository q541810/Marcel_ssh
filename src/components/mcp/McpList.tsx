import { useEffect, useState } from 'react';
import { useMcpStore } from '@/stores/mcpStore';
import type { McpServer, McpServerInput } from '@/lib/types';
import McpServerModal from './McpServerModal';

export default function McpList() {
  const servers = useMcpStore((s) => s.servers);
  const statuses = useMcpStore((s) => s.statuses);
  const loading = useMcpStore((s) => s.loading);
  const error = useMcpStore((s) => s.error);
  const fetchServers = useMcpStore((s) => s.fetchServers);
  const addServer = useMcpStore((s) => s.addServer);
  const updateServer = useMcpStore((s) => s.updateServer);
  const deleteServer = useMcpStore((s) => s.deleteServer);
  const toggleServer = useMcpStore((s) => s.toggleServer);
  const refreshTools = useMcpStore((s) => s.refreshTools);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<McpServer | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    fetchServers();
  }, [fetchServers]);

  const filtered = servers.filter((s) => {
    const lower = query.toLowerCase();
    return s.name.toLowerCase().includes(lower) || s.url.toLowerCase().includes(lower);
  });

  const handleSave = async (input: McpServerInput) => {
    if (editing) {
      await updateServer(editing.id, input);
    } else {
      await addServer(input);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
        <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">自定义 MCP</h2>
        <button
          onClick={() => { setEditing(null); setModalOpen(true); }}
          className="p-1 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 transition-colors"
          title="新建 MCP"
          aria-label="新建 MCP"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>
      </div>

      <div className="p-2 border-b border-zinc-800">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索 MCP..."
          className="w-full rounded-lg bg-zinc-800 border border-zinc-700 px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500"
        />
      </div>

      {(servers.length > 0 || error) && (
        <div className="px-3 py-1.5 border-b border-zinc-800/50 text-xs text-zinc-500">
          {servers.length > 0 && <span>{servers.length} 个 MCP · {servers.filter((s) => s.enabled).length} 个已启用</span>}
          {error && <div className="mt-1 text-red-400">{error}</div>}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-2 space-y-1 text-sm">
        {loading && servers.length === 0 && <p className="text-zinc-500 text-center mt-4">加载中...</p>}
        {!loading && servers.length === 0 && (
          <div className="text-center mt-6 px-3">
            <p className="text-zinc-500 mb-3">尚未配置任何 MCP 服务器</p>
            <button onClick={() => setModalOpen(true)} className="text-xs text-indigo-400 hover:text-indigo-300 underline">创建 MCP</button>
          </div>
        )}
        {filtered.map((server) => {
          const status = statuses[server.id];
          const tools = status?.tools ?? [];
          const subtitle = server.url || '';
          return (
            <div key={server.id} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2 space-y-2">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => toggleServer(server.id)}
                  title={server.enabled ? '禁用' : '启用'}
                  className={'relative w-7 h-4 rounded-full transition-colors ' + (server.enabled ? 'bg-indigo-500' : 'bg-zinc-700')}
                >
                  <span className={'absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ' + (server.enabled ? 'left-3.5' : 'left-0.5')} />
                </button>
                <button onClick={() => setExpandedId(expandedId === server.id ? null : server.id)} className="flex-1 min-w-0 text-left">
                  <div className="text-zinc-200 font-medium truncate">{server.name}</div>
                  <div className="text-xs text-zinc-500 truncate">{subtitle || <span className="italic text-zinc-600">未配置详情</span>}</div>
                </button>
              </div>
              {status?.error && <div className="text-xs text-red-400 break-words">{status.error}</div>}
              {status && tools.length === 0 && !status.error && (
                <div className="text-xs text-amber-400">未发现工具 — 点击刷新</div>
              )}
              <div className="flex items-center gap-1 text-xs">
                <button onClick={() => refreshTools(server.id)} className="px-2 py-1 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700">刷新工具</button>
                <button onClick={() => { setEditing(server); setModalOpen(true); }} className="px-2 py-1 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700">编辑</button>
                <button
                  onClick={() => { if (confirm(`确定删除 "${server.name}" 吗？`)) deleteServer(server.id); }}
                  className="px-2 py-1 rounded bg-zinc-800 text-red-300 hover:bg-zinc-700"
                >
                  删除
                </button>
              </div>
              {expandedId === server.id && (
                <div className="rounded-md bg-zinc-950/60 border border-zinc-800 p-2 text-xs text-zinc-400 space-y-1">
                  <div>{tools.length} 个工具 · {server.trusted ? '已信任' : '默认需审批'}</div>
                  {tools.map((tool) => (
                    <div key={tool.name} className="border-t border-zinc-800 pt-1 first:border-t-0 first:pt-0">
                      <div className="text-zinc-200 font-mono">{tool.name}</div>
                      {tool.description && <div className="text-zinc-500">{tool.description}</div>}
                    </div>
                  ))}
                  {tools.length === 0 && <div className="text-zinc-600">尚未发现工具，点击"刷新工具"。</div>}
                </div>
              )}
            </div>
          );
        })}
        {!loading && servers.length > 0 && filtered.length === 0 && <p className="text-zinc-500 text-center mt-4">无匹配 MCP</p>}
      </div>
      <McpServerModal
        open={modalOpen}
        server={editing}
        onClose={() => { setModalOpen(false); setEditing(null); }}
        onSave={handleSave}
      />
    </div>
  );
}
