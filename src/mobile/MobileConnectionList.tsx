import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Loader2,
  Pencil,
  Plus,
  Server,
  Trash2,
  WifiOff,
} from 'lucide-react';
import { useConnectionStore } from '@/stores/connectionStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSessionLifecycle } from '@/hooks/useSessionLifecycle';
import { useConnectWithPassword } from '@/hooks/useConnectWithPassword';
import { useHostKeyMismatch } from '@/hooks/useHostKeyMismatch';
import { usePrivacyMode } from '@/hooks/usePrivacyMode';
import { isAndroidBridgeAvailable } from './mobileBridge';
import {
  dismissKeepAliveTipPermanently,
  isKeepAliveTipDismissed,
} from '@/lib/keepAliveTip';
import MobileKeepAliveTipCard from './MobileKeepAliveTipCard';
import {
  asHostKeyMismatch,
  getErrorMessage,
  parseAppError,
} from '@/lib/errors';
import { isPassphraseProblem, keyNeedsPassphrase } from '@/lib/privateKey';
import { formatConnLabel } from '@/lib/privacy';
import type { ConnectionConfig, SavedConnection } from '@/lib/types';
import * as tauri from '@/lib/tauri';
import {
  UNGROUPED_NAME,
  groupNameOf,
  toOrderEntries,
} from '@/lib/connectionOrder';
import { useLongPressDrag } from './useLongPressDrag';
import { listSessionsToDisconnectBeforeNewConnect } from './sessionUi';
import MobileConnectionForm from './MobileConnectionForm';
import MobileSheet from './ui/MobileSheet';

interface MobileConnectionListProps {
  onBack?: () => void;
  backLabel?: string;
}

export default function MobileConnectionList({
  onBack,
  backLabel = '返回会话',
}: MobileConnectionListProps = {}) {
  const connections = useConnectionStore((s) => s.connections);
  const loading = useConnectionStore((s) => s.loading);
  const error = useConnectionStore((s) => s.error);
  const fetchConnections = useConnectionStore((s) => s.fetchConnections);
  const addConnection = useConnectionStore((s) => s.addConnection);
  const removeConnection = useConnectionStore((s) => s.removeConnection);
  const connect = useSessionStore((s) => s.connect);
  const connectWithSavedPassword = useSessionStore(
    (s) => s.connectWithSavedPassword,
  );
  const connectWithSavedPassphrase = useSessionStore(
    (s) => s.connectWithSavedPassphrase,
  );
  const disconnect = useSessionStore((s) => s.disconnect);
  const { onConnected, onDisconnected } = useSessionLifecycle();
  const { prompt: promptPassword, Prompt: PasswordPromptEl } =
    useConnectWithPassword();
  const mismatch = useHostKeyMismatch();
  const privacyMode = usePrivacyMode();
  const applyConnectionOrder = useConnectionStore((s) => s.applyConnectionOrder);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  // 长按拖拽排序（移动端列表是平铺的，拖动即全局顺序；分组仍由编辑表单设置）
  const drag = useLongPressDrag({
    orderedIds: connections.map((c) => c.id),
    onCommit: (orderedIds) => {
      const byId = new Map(connections.map((c) => [c.id, c]));
      const next = orderedIds
        .map((id) => byId.get(id))
        .filter((c): c is SavedConnection => c != null);
      if (next.length !== connections.length) return;
      void applyConnectionOrder(toOrderEntries(next));
    },
  });
  const [localError, setLocalError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState<
    SavedConnection | undefined
  >(undefined);
  const [deleteTarget, setDeleteTarget] = useState<SavedConnection | null>(
    null,
  );
  // 后台保活提示：仅在连接列表页（未连上）显示
  const keepAliveEnabled = useSettingsStore(
    (s) => s.settings.mobileBackgroundSettings.keepAliveEnabled,
  );
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const [keepAliveDismissedSession, setKeepAliveDismissedSession] =
    useState(false);
  const [keepAliveDismissedForever, setKeepAliveDismissedForever] = useState(
    () => isKeepAliveTipDismissed(),
  );

  // 开启保活后重置"忽略"状态：若用户又关闭保活，应再次提示（除非点了不再显示）
  useEffect(() => {
    if (keepAliveEnabled) setKeepAliveDismissedSession(false);
  }, [keepAliveEnabled]);

  const showKeepAliveTip =
    settingsLoaded &&
    !keepAliveEnabled &&
    !keepAliveDismissedSession &&
    !keepAliveDismissedForever &&
    isAndroidBridgeAvailable();

  const handleKeepAliveJump = () => {
    window.dispatchEvent(
      new CustomEvent('mobile:open-settings', {
        detail: { category: 'notification-background' },
      }),
    );
  };

  const handleKeepAliveIgnore = () => {
    setKeepAliveDismissedSession(true);
  };

  const handleKeepAliveNeverShow = () => {
    dismissKeepAliveTipPermanently();
    setKeepAliveDismissedForever(true);
  };

  useEffect(() => {
    void fetchConnections();
  }, [fetchConnections]);

  const clearOtherSessions = async () => {
    const { sessions } = useSessionStore.getState();
    const ids = listSessionsToDisconnectBeforeNewConnect(sessions);
    for (const id of ids) {
      const configId = sessions[id]?.configId;
      try {
        await disconnect(id);
      } catch {
        /* best-effort; continue so new connect can proceed */
      }
      if (configId) onDisconnected(configId, id);
    }
  };

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
          keyId: conn.keyId,
          keyPath: conn.keyPath,
          passphrase,
        };
        break;
      default:
        // 历史数据里可能有已不再支持的取值（例如早期的 "Agent"）：
        // 说清楚是哪一条、该怎么修，而不是发一个后端必然拒绝的请求
        setLocalError(
          `「${conn.name}」保存的认证方式（${conn.authMethod}）已不再支持，请编辑这条连接、重新选择认证方式`,
        );
        return;
    }

    const config: ConnectionConfig = {
      host: conn.host,
      port: conn.port,
      username: conn.username,
      authMethod,
      connectionId: conn.id,
      trustNewHostKey: trust,
    };

    setConnectingId(conn.id);
    setLocalError(null);
    try {
      await clearOtherSessions();
      const sessionId = await connect(config);
      if (config.connectionId) {
        void onConnected(config.connectionId, sessionId).catch(() => {});
      }
    } catch (err) {
      if (!trust) {
        const m = asHostKeyMismatch(parseAppError(err));
        if (m) {
          mismatch.prompt({
            data: m,
            onTrust: () => void doConnect(conn, password, passphrase, true),
          });
          return;
        }
      }
      setLocalError(getErrorMessage(err));
    } finally {
      setConnectingId(null);
    }
  };

  const promptForPassword = (conn: SavedConnection) => {
    promptPassword({
      title: 'SSH 密码',
      description: `连接到 ${formatConnLabel(conn.username, conn.host, conn.port, privacyMode)}`,
      allowRemember: true,
      onSubmit: async (password, remember) => {
        if (remember) {
          try {
            await tauri.savePassword(conn.id, password);
          } catch {
            /* keychain optional */
          }
        }
        await doConnect(conn, password);
      },
    });
  };

  const promptForPassphrase = (conn: SavedConnection) => {
    promptPassword({
      title: '私钥密码',
      description: `连接到 ${formatConnLabel(conn.username, conn.host, conn.port, privacyMode)}`,
      allowRemember: true,
      onSubmit: async (passphrase, remember) => {
        if (remember) {
          try {
            await tauri.savePassphrase(conn.id, passphrase);
          } catch {
            /* keychain optional */
          }
        }
        await doConnect(conn, undefined, passphrase);
      },
    });
  };

  const handleConnect = async (connection: SavedConnection) => {
    setLocalError(null);
    if (connection.authMethod === 'Password') {
      try {
        const stored = await tauri.hasPassword(connection.id);
        if (stored) {
          const connLabel = formatConnLabel(connection.username, connection.host, connection.port, privacyMode);
          setConnectingId(connection.id);
          try {
            await clearOtherSessions();
            const sessionId = await connectWithSavedPassword(
              connection.id,
              connLabel,
            );
            void onConnected(connection.id, sessionId).catch(() => {});
            return;
          } catch (err) {
            const m = asHostKeyMismatch(parseAppError(err));
            if (m) {
              mismatch.prompt({
                data: m,
                onTrust: async () => {
                  try {
                    setConnectingId(connection.id);
                    await clearOtherSessions();
                    const sid = await connectWithSavedPassword(
                      connection.id,
                      connLabel,
                      true,
                    );
                    void onConnected(connection.id, sid).catch(() => {});
                  } catch (e) {
                    setLocalError(getErrorMessage(e));
                  } finally {
                    setConnectingId(null);
                  }
                },
              });
              return;
            }
            setLocalError(getErrorMessage(err));
            return;
          } finally {
            setConnectingId(null);
          }
        }
      } catch {
        /* fall through to prompt */
      }
      promptForPassword(connection);
      return;
    }

    if (connection.authMethod === 'PrivateKey') {
      const hasSavedPassphrase = await tauri
        .hasPassphrase(connection.id)
        .catch(() => false);
      if (hasSavedPassphrase) {
        const connLabel = formatConnLabel(connection.username, connection.host, connection.port, privacyMode);
        setConnectingId(connection.id);
        try {
          await clearOtherSessions();
          const sessionId = await connectWithSavedPassphrase(
            connection.id,
            connLabel,
          );
          void onConnected(connection.id, sessionId).catch(() => {});
          return;
        } catch (err) {
          const m = asHostKeyMismatch(parseAppError(err));
          if (m) {
            mismatch.prompt({
              data: m,
              onTrust: async () => {
                try {
                  setConnectingId(connection.id);
                  await clearOtherSessions();
                  const sid = await connectWithSavedPassphrase(
                    connection.id,
                    connLabel,
                    true,
                  );
                  void onConnected(connection.id, sid).catch(() => {});
                } catch (e) {
                  setLocalError(getErrorMessage(e));
                } finally {
                  setConnectingId(null);
                }
              },
            });
            return;
          }
          // 真需要密码（保存的那把已经不对了）才追问；别的原因就说别的
          if (isPassphraseProblem(err)) {
            promptForPassphrase(connection);
            return;
          }
          setLocalError(getErrorMessage(err));
          return;
        } finally {
          setConnectingId(null);
        }
      }

      // 密钥库里的私钥是带密码的、而本地没存：直接问，不拿一次失败去试
      if (await keyNeedsPassphrase(connection)) {
        promptForPassphrase(connection);
        return;
      }

      try {
        setConnectingId(connection.id);
        await clearOtherSessions();
        const config: ConnectionConfig = {
          host: connection.host,
          port: connection.port,
          username: connection.username,
          authMethod: {
            type: 'PrivateKey',
            keyId: connection.keyId,
            keyPath: connection.keyPath,
          },
          connectionId: connection.id,
        };
        const sessionId = await connect(config);
        void onConnected(connection.id, sessionId).catch(() => {});
        return;
      } catch (err) {
        const m = asHostKeyMismatch(parseAppError(err));
        if (m) {
          mismatch.prompt({
            data: m,
            onTrust: () =>
              void doConnect(connection, undefined, undefined, true),
          });
          return;
        }
        // 这一次尝试不是白费的：后端明确告诉我们原因，只有"缺密码 / 密码错"
        // 才继续追问，其他原因照实显示
        if (isPassphraseProblem(err)) {
          promptForPassphrase(connection);
          return;
        }
        setLocalError(getErrorMessage(err));
      } finally {
        setConnectingId(null);
      }
      return;
    }

    await doConnect(connection);
  };

  const openNewForm = () => {
    setEditingConnection(undefined);
    setFormOpen(true);
  };

  const openEditForm = (conn: SavedConnection) => {
    setEditingConnection(conn);
    setFormOpen(true);
  };

  const handleSaveConnection = async (saved: SavedConnection) => {
    setLocalError(null);
    await addConnection(saved);
    setFormOpen(false);
    setEditingConnection(undefined);
  };

  const handleDeleteConnection = async () => {
    if (!deleteTarget) return;
    setLocalError(null);
    await removeConnection(deleteTarget.id);
    setDeleteTarget(null);
  };

  const displayError = localError ?? error;

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-zinc-950"
      style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
    >
      <header className="flex-shrink-0 border-b border-zinc-800 px-4 py-3">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="mb-2 flex items-center gap-1 text-xs text-indigo-400 active:text-indigo-300"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {backLabel}
          </button>
        )}
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-base font-semibold text-zinc-100">连接</h1>
            <p className="mt-0.5 text-xs text-zinc-500">
              选择已保存的 SSH 连接
            </p>
          </div>
          <button
            type="button"
            onClick={openNewForm}
            className="flex flex-shrink-0 items-center gap-1 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white active:bg-indigo-500"
          >
            <Plus className="h-3.5 w-3.5" />
            新建
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {loading && connections.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-zinc-500">
            <Loader2 className="h-6 w-6 animate-spin" />
            <span className="text-sm">加载连接列表…</span>
          </div>
        )}

        {!loading && connections.length === 0 && !displayError && (
          <div className="flex flex-col items-center justify-center gap-3 px-4 py-16 text-center">
            <WifiOff className="h-10 w-10 text-zinc-600" />
            <p className="text-sm text-zinc-400">暂无已保存的连接</p>
            <button
              type="button"
              onClick={openNewForm}
              className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white active:bg-indigo-500"
            >
              <Plus className="h-4 w-4" />
              新建连接
            </button>
            <p className="max-w-xs text-xs leading-relaxed text-zinc-600">
              保存的连接会安全存于本机密钥链与配置中。
            </p>
          </div>
        )}

        {displayError && (
          <div className="mb-3 rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-xs text-red-300">
            {displayError}
          </div>
        )}

        <ul className="flex flex-col gap-2">
          {connections.map((conn) => {
            const busy = connectingId === conn.id;
            const groupName = groupNameOf(conn);
            const dragging = drag.draggingId === conn.id;
            return (
              <li
                key={conn.id}
                ref={drag.registerItem(conn.id)}
                onTouchStart={drag.onTouchStart(conn.id)}
                onTouchMove={drag.onTouchMovePending}
                onTouchEnd={drag.onTouchEndPending}
                onTouchCancel={drag.onTouchEndPending}
                style={{ transform: drag.translateFor(conn.id) }}
                className={
                  // 被拖的行必须零过渡（跟手 1:1）；其余行保留过渡，拖拽时才有让位动画
                  dragging
                    ? 'relative z-10 shadow-xl shadow-black/40'
                    : `transition-transform ${drag.isDragging ? 'duration-150' : ''}`
                }
              >
                <div className="flex w-full items-center rounded-xl border border-zinc-800 bg-zinc-900 pr-1">
                  <button
                    type="button"
                    disabled={busy || connectingId != null}
                    onClick={() => {
                      // 长按拖拽松手后的合成点击要忽略，否则一拖就顺带连上了
                      if (drag.shouldSuppressClick()) return;
                      void handleConnect(conn);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-l-xl px-3 py-3 text-left active:scale-[0.99] disabled:opacity-60"
                  >
                    <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-zinc-800 text-indigo-400">
                      {busy ? (
                        <Loader2 className="h-5 w-5 animate-spin" />
                      ) : (
                        <Server className="h-5 w-5" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-zinc-100">
                        {conn.name || formatConnLabel(conn.username, conn.host, conn.port, privacyMode)}
                      </div>
                      <div className="truncate text-xs text-zinc-500">
                        {formatConnLabel(conn.username, conn.host, conn.port, privacyMode)}
                        {groupName !== UNGROUPED_NAME && ` · ${groupName}`}
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    data-nodrag
                    onClick={() => openEditForm(conn)}
                    className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-zinc-400 active:bg-zinc-800"
                    aria-label={`编辑 ${conn.name}`}
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    data-nodrag
                    onClick={() => setDeleteTarget(conn)}
                    className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-zinc-500 active:bg-zinc-800 active:text-red-400"
                    aria-label={`删除 ${conn.name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {showKeepAliveTip && (
        <MobileKeepAliveTipCard
          onJump={handleKeepAliveJump}
          onIgnore={handleKeepAliveIgnore}
          onNeverShow={handleKeepAliveNeverShow}
        />
      )}

      {/* Create / edit connection sheet */}
      <MobileConnectionForm
        open={formOpen}
        connection={editingConnection}
        onSave={handleSaveConnection}
        onCancel={() => {
          setFormOpen(false);
          setEditingConnection(undefined);
        }}
      />

      {/* Delete confirm sheet */}
      <MobileSheet
        open={deleteTarget != null}
        onClose={() => setDeleteTarget(null)}
        title="确认删除"
      >
        <div className="flex flex-col gap-2 px-4 pb-4">
          <p className="pb-1 text-sm text-zinc-400">
            删除连接「
            {deleteTarget?.name ||
              `${deleteTarget?.username}@${deleteTarget?.host}`}
            」？此操作不可撤销。
          </p>
          <button
            type="button"
            onClick={() => void handleDeleteConnection()}
            className="rounded-xl bg-red-600 px-4 py-3 text-sm font-medium text-white active:bg-red-500"
          >
            删除
          </button>
          <button
            type="button"
            onClick={() => setDeleteTarget(null)}
            className="rounded-xl px-4 py-3 text-sm text-zinc-400 active:bg-zinc-800"
          >
            取消
          </button>
        </div>
      </MobileSheet>

      {PasswordPromptEl}
      {mismatch.Modal}
    </div>
  );
}
