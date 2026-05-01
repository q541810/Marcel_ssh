import { useState, useEffect } from 'react';
import { useConnectionStore } from '@/stores/connectionStore';
import { useSessionStore } from '@/stores/sessionStore';
import type { SavedConnection, ConnectionConfig } from '@/lib/types';
import * as tauri from '@/lib/tauri';
import Modal from '@/components/ui/Modal';
import ConnectionForm from './ConnectionForm';
import PasswordPrompt from './PasswordPrompt';

export default function ConnectionList() {
  const connections = useConnectionStore((s) => s.connections);
  const loading = useConnectionStore((s) => s.loading);
  const fetchConnections = useConnectionStore((s) => s.fetchConnections);
  const addConnection = useConnectionStore((s) => s.addConnection);
  const removeConnection = useConnectionStore((s) => s.removeConnection);
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId);
  const setActiveConnection = useConnectionStore((s) => s.setActiveConnection);
  const connect = useSessionStore((s) => s.connect);

  const [searchQuery, setSearchQuery] = useState('');
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    connection: SavedConnection;
  } | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingConnection, setEditingConnection] =
    useState<SavedConnection | undefined>(undefined);
  const [pendingPasswordConn, setPendingPasswordConn] =
    useState<SavedConnection | null>(null);

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  const filteredConnections = connections.filter(
    (c) =>
      c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.host.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  // Group connections by group field
  const grouped = filteredConnections.reduce<Record<string, SavedConnection[]>>(
    (acc, conn) => {
      const group = conn.group || '未分组';
      if (!acc[group]) acc[group] = [];
      acc[group].push(conn);
      return acc;
    },
    {},
  );

  /**
   * Attempt to connect with the given password (or no password for non-Password
   * methods). On password-auth failure with a saved password, the stored entry
   * is purged and the user is prompted to re-enter.
   */
  const doConnect = async (conn: SavedConnection, password?: string) => {
    setActiveConnection(conn.id);
    let authMethod: ConnectionConfig['authMethod'];
    switch (conn.authMethod) {
      case 'Password':
        if (!password) {
          setPendingPasswordConn(conn);
          return;
        }
        authMethod = { type: 'Password', password };
        break;
      case 'PrivateKey':
        authMethod = {
          type: 'PrivateKey',
          keyPath: conn.keyPath ?? '',
        };
        break;
      case 'Agent':
      default:
        authMethod = { type: 'Agent' };
    }
    const config: ConnectionConfig = {
      host: conn.host,
      port: conn.port,
      username: conn.username,
      authMethod,
    };
    try {
      await connect(config);
    } catch (err) {
      console.error('连接失败:', err);
      // If we used a saved password and it failed, clear it so we re-prompt
      if (password && conn.authMethod === 'Password') {
        try {
          await tauri.deletePassword(conn.id);
        } catch {
          /* ignore */
        }
        // Re-prompt
        setPendingPasswordConn(conn);
      }
    }
  };

  /**
   * Click handler for a saved connection. For password-auth connections,
   * tries to load a saved password from the OS keychain first.
   */
  const handleConnect = async (connection: SavedConnection) => {
    if (connection.authMethod === 'Password') {
      try {
        const saved = await tauri.getPassword(connection.id);
        if (saved) {
          await doConnect(connection, saved);
          return;
        }
      } catch (err) {
        console.warn('读取已保存密码失败:', err);
      }
      // No saved password — prompt
      setPendingPasswordConn(connection);
      return;
    }
    await doConnect(connection);
  };

  const handlePasswordSubmit = async (password: string, remember: boolean) => {
    if (!pendingPasswordConn) return;
    const conn = pendingPasswordConn;
    setPendingPasswordConn(null);
    if (remember) {
      try {
        await tauri.savePassword(conn.id, password);
      } catch (err) {
        console.warn('保存密码到密钥链失败:', err);
      }
    }
    await doConnect(conn, password);
  };

  const handleContextMenu = (e: React.MouseEvent, connection: SavedConnection) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, connection });
  };

  const closeContextMenu = () => setContextMenu(null);

  const handleSave = async (saved: SavedConnection) => {
    await addConnection(saved);
    setFormOpen(false);
    setEditingConnection(undefined);
  };

  const openNewConnectionForm = () => {
    setEditingConnection(undefined);
    setFormOpen(true);
  };

  const openEditForm = (conn: SavedConnection) => {
    setEditingConnection(conn);
    setFormOpen(true);
    closeContextMenu();
  };

  return (
    <div className="flex flex-col h-full" onClick={closeContextMenu}>
      {/* Header with new connection button */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
        <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
          已保存的连接
        </h2>
        <button
          onClick={openNewConnectionForm}
          className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 transition-colors"
          title="新建连接"
          aria-label="新建连接"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>
      </div>

      {/* Search */}
      <div className="p-2 border-b border-zinc-800">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="搜索连接..."
          className="w-full rounded bg-zinc-800 border border-zinc-700 px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500"
        />
      </div>

      {/* Connection list */}
      <div className="flex-1 overflow-y-auto p-2 space-y-3">
        {loading && (
          <p className="text-sm text-zinc-500 text-center mt-4">加载中...</p>
        )}
        {!loading && filteredConnections.length === 0 && (
          <div className="text-center mt-6 px-2">
            <p className="text-sm text-zinc-500 mb-3">暂无已保存的连接</p>
            <button
              onClick={openNewConnectionForm}
              className="text-xs text-indigo-400 hover:text-indigo-300 underline"
            >
              点击此处新建连接
            </button>
          </div>
        )}
        {Object.entries(grouped).map(([group, conns]) => (
          <div key={group}>
            <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider px-2 mb-1">
              {group}
            </h3>
            <div className="space-y-0.5">
              {conns.map((conn) => (
                <button
                  key={conn.id}
                  onClick={() => handleConnect(conn)}
                  onContextMenu={(e) => handleContextMenu(e, conn)}
                  className={`
                    w-full text-left px-2 py-2 rounded text-sm transition-colors
                    ${
                      activeConnectionId === conn.id
                        ? 'bg-indigo-900/30 border border-indigo-700'
                        : 'hover:bg-zinc-800 border border-transparent'
                    }
                  `}
                >
                  <div className="font-medium text-zinc-200 truncate">
                    {conn.name}
                  </div>
                  <div className="text-xs text-zinc-500 truncate">
                    {conn.username}@{conn.host}:{conn.port}
                  </div>
                  {conn.lastConnected && (
                    <div className="text-xs text-zinc-600 mt-0.5">
                      上次连接：{new Date(conn.lastConnected).toLocaleDateString()}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-zinc-800 border border-zinc-700 rounded shadow-lg py-1 min-w-32"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              handleConnect(contextMenu.connection);
              closeContextMenu();
            }}
            className="w-full text-left px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700"
          >
            连接
          </button>
          <button
            onClick={() => openEditForm(contextMenu.connection)}
            className="w-full text-left px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700"
          >
            编辑
          </button>
          <hr className="border-zinc-700 my-1" />
          <button
            onClick={() => {
              if (confirm(`确定要删除连接 "${contextMenu.connection.name}" 吗？`)) {
                removeConnection(contextMenu.connection.id);
              }
              closeContextMenu();
            }}
            className="w-full text-left px-3 py-1.5 text-sm text-red-400 hover:bg-zinc-700"
          >
            删除
          </button>
        </div>
      )}

      {/* New / Edit connection modal */}
      <Modal
        open={formOpen}
        onClose={() => {
          setFormOpen(false);
          setEditingConnection(undefined);
        }}
        title={editingConnection ? '编辑连接' : '新建连接'}
      >
        <ConnectionForm
          connection={editingConnection}
          onSave={handleSave}
          onCancel={() => {
            setFormOpen(false);
            setEditingConnection(undefined);
          }}
        />
      </Modal>

      {/* Password prompt for Password-auth connections */}
      <PasswordPrompt
        open={!!pendingPasswordConn}
        title="SSH 密码"
        description={
          pendingPasswordConn
            ? `连接到 ${pendingPasswordConn.username}@${pendingPasswordConn.host}:${pendingPasswordConn.port}`
            : undefined
        }
        allowRemember
        onSubmit={handlePasswordSubmit}
        onCancel={() => setPendingPasswordConn(null)}
      />
    </div>
  );
}
