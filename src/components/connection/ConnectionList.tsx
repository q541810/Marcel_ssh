import { useState, useEffect } from 'react';
import { useConnectionStore } from '@/stores/connectionStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useSessionLifecycle } from '@/hooks/useSessionLifecycle';
import { useConnectWithPassword } from '@/hooks/useConnectWithPassword';
import { useHostKeyMismatch } from '@/hooks/useHostKeyMismatch';
import { asHostKeyMismatch, parseAppError } from '@/lib/errors';
import type { SavedConnection, ConnectionConfig } from '@/lib/types';
import * as tauri from '@/lib/tauri';
import Modal from '@/components/ui/Modal';
import ListPanel from '@/components/ui/ListPanel';
import ContextMenu from '@/components/ui/ContextMenu';
import ConnectionForm from './ConnectionForm';

export default function ConnectionList() {
  const connections = useConnectionStore((s) => s.connections);
  const loading = useConnectionStore((s) => s.loading);
  const fetchConnections = useConnectionStore((s) => s.fetchConnections);
  const addConnection = useConnectionStore((s) => s.addConnection);
  const removeConnection = useConnectionStore((s) => s.removeConnection);
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId);
  const setActiveConnection = useConnectionStore((s) => s.setActiveConnection);
  const connect = useSessionStore((s) => s.connect);
  const connectWithSavedPassword = useSessionStore((s) => s.connectWithSavedPassword);
  const connectWithSavedPassphrase = useSessionStore((s) => s.connectWithSavedPassphrase);
  const { onConnected } = useSessionLifecycle();

  const [searchQuery, setSearchQuery] = useState('');
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    connection: SavedConnection;
  } | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingConnection, setEditingConnection] =
    useState<SavedConnection | undefined>(undefined);
  const { prompt: promptPassword, Prompt: PasswordPromptEl } = useConnectWithPassword();
  const mismatch = useHostKeyMismatch();

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
   *
   * `trust` is only set true on the retry path after the user confirms the
   * HostKeyMismatch modal — it drives `KnownHostsStore::replace` in the
   * backend so the stored fingerprint is overwritten rather than rejected.
   */
  const doConnect = async (
    conn: SavedConnection,
    password?: string,
    passphrase?: string,
    trust = false,
  ) => {
    let authMethod: ConnectionConfig['authMethod'];
    switch (conn.authMethod) {
      case 'Password':
        if (!password) {
          promptForPassword(conn);
          return;
        }
        authMethod = { type: 'Password', password };
        break;
      case 'PrivateKey':
        authMethod = {
          type: 'PrivateKey',
          keyPath: conn.keyPath ?? '',
          passphrase,
        };
        break;
      case 'Agent':
      default:
        authMethod = { type: 'Agent' };
    }
    // Jump secrets are loaded on the Rust side from keychain when connectionId is set.
    const config: ConnectionConfig = {
      host: conn.host,
      port: conn.port,
      username: conn.username,
      authMethod,
      connectionId: conn.id,
      trustNewHostKey: trust,
    };
    try {
      const sessionId = await connect(config);
      if (config.connectionId) {
        onConnected(config.connectionId, sessionId);
      }
    } catch (err) {
      if (!trust) {
        const m = asHostKeyMismatch(parseAppError(err));
        if (m) {
          mismatch.prompt({
            data: m,
            onTrust: () => doConnect(conn, password, passphrase, true),
          });
          return;
        }
      }
      console.error('连接失败:', err);
    }
  };

  const promptForPassword = (conn: SavedConnection) => {
    promptPassword({
      title: 'SSH 密码',
      description: `连接到 ${conn.username}@${conn.host}:${conn.port}`,
      allowRemember: true,
      onSubmit: async (password, remember) => {
        if (remember) {
          try {
            await tauri.savePassword(conn.id, password);
          } catch (err) {
            console.warn('保存密码到密钥链失败:', err);
          }
        }
        await doConnect(conn, password);
      },
    });
  };

  const promptForPassphrase = (conn: SavedConnection) => {
    promptPassword({
      title: '私钥密码',
      description: `连接到 ${conn.username}@${conn.host}:${conn.port}`,
      allowRemember: true,
      onSubmit: async (passphrase, remember) => {
        if (remember) {
          try {
            await tauri.savePassphrase(conn.id, passphrase);
          } catch (err) {
            console.warn('保存 passphrase 到密钥链失败:', err);
          }
        }
        await doConnect(conn, undefined, passphrase);
      },
    });
  };

  /**
   * Click handler for a saved connection. For password-auth connections,
   * checks if a password is saved in the OS keychain. If so, connects via
   * a Rust-side command that reads the password from the keychain without
   * exposing it to the WebView. Otherwise prompts the user.
   */
  const handleConnect = async (connection: SavedConnection) => {
    if (connection.authMethod === 'Password') {
      try {
        const stored = await tauri.hasPassword(connection.id);
        if (stored) {
          const connLabel = `${connection.username}@${connection.host}:${connection.port}`;
          try {
            const sessionId = await connectWithSavedPassword(connection.id, connLabel);
            if (connection.id) {
              onConnected(connection.id, sessionId);
            }
            return;
          } catch (err) {
            const m = asHostKeyMismatch(parseAppError(err));
            if (m) {
              mismatch.prompt({
                data: m,
                onTrust: async () => {
                  try {
                    const sid = await connectWithSavedPassword(connection.id, connLabel, true);
                    if (connection.id) onConnected(connection.id, sid);
                  } catch (e) {
                    console.error('连接失败:', e);
                  }
                },
              });
              return;
            }
            console.warn('连接失败:', err);
            return;
          }
        }
      } catch (err) {
        console.warn('检查已保存密码失败:', err);
      }
      promptForPassword(connection);
      return;
    }
    if (connection.authMethod === 'PrivateKey') {
      const hasSavedPassphrase = await tauri.hasPassphrase(connection.id).catch((err) => {
        console.warn('检查已保存 passphrase 失败:', err);
        return false;
      });
      if (hasSavedPassphrase) {
        const connLabel = `${connection.username}@${connection.host}:${connection.port}`;
        try {
          const sessionId = await connectWithSavedPassphrase(connection.id, connLabel);
          onConnected(connection.id, sessionId);
          return;
        } catch (err) {
          const m = asHostKeyMismatch(parseAppError(err));
          if (m) {
            mismatch.prompt({
              data: m,
              onTrust: async () => {
                try {
                  const sid = await connectWithSavedPassphrase(connection.id, connLabel, true);
                  onConnected(connection.id, sid);
                } catch (e) {
                  console.error('连接失败:', e);
                }
              },
            });
            return;
          }
          console.warn('passphrase 连接失败，尝试无 passphrase:', err);
        }
      }
      try {
        const config: ConnectionConfig = {
          host: connection.host,
          port: connection.port,
          username: connection.username,
          authMethod: { type: 'PrivateKey', keyPath: connection.keyPath ?? '' },
          connectionId: connection.id,
        };
        const sessionId = await connect(config);
        if (connection.id) {
          onConnected(connection.id, sessionId);
        }
        return;
      } catch (err) {
        const m = asHostKeyMismatch(parseAppError(err));
        if (m) {
          mismatch.prompt({
            data: m,
            onTrust: () => doConnect(
              connection,
              undefined,
              undefined,
              true,
            ),
          });
          return;
        }
        console.warn('无 passphrase 连接失败，可能私钥已加密:', err);
      }
      promptForPassphrase(connection);
      return;
    }
    await doConnect(connection);
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

  const contextMenuItems = contextMenu
    ? [
        {
          label: '连接',
          onClick: () => handleConnect(contextMenu.connection),
        },
        {
          label: '编辑',
          onClick: () => openEditForm(contextMenu.connection),
        },
        { divider: true } as { label: string; onClick: () => void; variant?: 'default' | 'danger'; divider?: boolean },
        {
          label: '删除',
          variant: 'danger' as const,
          onClick: () => {
            if (confirm(`确定要删除连接 "${contextMenu.connection.name}" 吗？`)) {
              removeConnection(contextMenu.connection.id);
            }
          },
        },
      ]
    : [];

  return (
    <ListPanel
      data-region="sessions"
      title="已保存的连接"
      onAdd={openNewConnectionForm}
      addButtonTitle="新建连接"
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      searchPlaceholder="搜索连接..."
    >
      <div className="space-y-3" onClick={closeContextMenu}>
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
            <div className="space-y-1">
              {conns.map((conn) => (
                <button
                  key={conn.id}
                  onClick={() => handleConnect(conn)}
                  onContextMenu={(e) => handleContextMenu(e, conn)}
                  className={`
                    w-full text-left px-2 py-2 rounded-lg text-sm transition-colors border
                    ${
                      activeConnectionId === conn.id
                        ? 'bg-indigo-900/30 border-indigo-700'
                        : 'bg-zinc-900/40 border-zinc-800 hover:border-zinc-700'
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
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={closeContextMenu}
        />
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

      {/* Password prompt */}
      {PasswordPromptEl}

      {/* Host key mismatch prompt */}
      {mismatch.Modal}
    </ListPanel>
  );
}
