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
import { getErrorMessage } from '@/lib/errors';
import { isDebugConnection } from '@/lib/debugServer';
import { formatConnLabel } from '@/lib/privacy';
import type { SavedConnection } from '@/lib/types';
import {
  loadCollapsedGroups,
  removeCollapsedGroup,
  saveCollapsedGroups,
  toggledCollapsedGroups,
} from '@/lib/connectionGroups';
import { createConnectFlow } from '@/lib/connectFlow';
import {
  groupConnections,
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
  const renameGroup = useConnectionStore((s) => s.renameGroup);
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
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState('');
  // 折叠状态（key = 分组名）。读写与 key 常量统一走 lib/connectionGroups。
  const [collapsedGroups, setCollapsedGroups] =
    useState<Set<string>>(loadCollapsedGroups);
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

  /** 切换分组的折叠状态（点击标题时）。 */
  const toggleGroupCollapse = (groupName: string) => {
    setCollapsedGroups((prev) => {
      const next = toggledCollapsedGroups(prev, groupName);
      saveCollapsedGroups(next);
      return next;
    });
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

  // 连接发起的判定树在 lib/connectFlow.ts（与桌面共用）。移动端与桌面的差异全部
  // 走注入回调：连接前断开其他会话（clearOtherSessions）、行内转圈（connectingId）、
  // 失败上红条；「查密钥链有没有存过」的失败保持静默退到追问（桌面此时只写 console）。
  const { handleConnect } = createConnectFlow({
    connect,
    connectWithSavedPassword,
    connectWithSavedPassphrase,
    promptPassword,
    promptMismatch: mismatch.prompt,
    onSessionEstablished: (connId, sessionId) => {
      if (connId) void onConnected(connId, sessionId).catch(() => {});
    },
    setLocalError,
    privacyMode,
    beforeAttempt: (connId, { clearLocalError }) => {
      setConnectingId(connId);
      if (clearLocalError) setLocalError(null);
    },
    beforeSessionConnect: clearOtherSessions,
    afterAttempt: () => setConnectingId(null),
    reportFailure: (err, site) => {
      if (site === 'checkPassword' || site === 'checkPassphrase') return;
      setLocalError(getErrorMessage(err));
    },
    onDebugConnect: (conn) => {
      useSessionStore.getState().connectDebugServer();
      useConnectionStore.getState().setActiveConnection(conn.id);
      onBack?.();
    },
  });

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

  const handleStartRenameGroup = (groupName: string) => {
    setRenamingGroup(groupName);
    setRenameInput(groupName);
  };

  const handleConfirmRenameGroup = async () => {
    if (!renamingGroup) return;
    const trimmed = renameInput.trim();
    if (trimmed !== renamingGroup) {
      setLocalError(null);
      await renameGroup(renamingGroup, trimmed);
      // 重命名后更新折叠状态的 key（旧名字的折叠状态丢弃）
      setCollapsedGroups((prev) => removeCollapsedGroup(prev, renamingGroup));
    }
    setRenamingGroup(null);
    setRenameInput('');
  };

  const handleCancelRenameGroup = () => {
    setRenamingGroup(null);
    setRenameInput('');
  };

  const displayError = localError ?? error;

  /** 删除确认里的连接称谓：名字优先，没名字就退到脱敏口径的 user@host:port。 */
  const deleteTargetLabel = deleteTarget
    ? deleteTarget.name ||
      formatConnLabel(deleteTarget.username, deleteTarget.host, deleteTarget.port, privacyMode)
    : '';

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

        {groupConnections(connections).map((group) => {
          const isCollapsed = collapsedGroups.has(group.name);
          return (
            <div key={group.name} className="mb-4">
              <div
                className="mb-2 flex w-full items-center gap-2 px-1 py-1"
                onContextMenu={(e) => {
                  e.preventDefault();
                  handleStartRenameGroup(group.name);
                }}
              >
                <button
                  type="button"
                  onClick={() => toggleGroupCollapse(group.name)}
                  className="flex items-center gap-2 active:opacity-70"
                >
                  <svg
                    className={`h-4 w-4 flex-shrink-0 text-zinc-500 transition-transform duration-[280ms] ${isCollapsed ? '' : 'rotate-90'}`}
                    style={{ transitionTimingFunction: 'cubic-bezier(0.32, 0.72, 0, 1)' }}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
                {renamingGroup === group.name ? (
                  <input
                    type="text"
                    value={renameInput}
                    onChange={(e) => setRenameInput(e.target.value)}
                    onBlur={handleConfirmRenameGroup}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        void handleConfirmRenameGroup();
                      } else if (e.key === 'Escape') {
                        handleCancelRenameGroup();
                      }
                    }}
                    autoFocus
                    className="flex-1 bg-zinc-800 text-zinc-200 px-2 py-1 rounded text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                ) : (
                  <button
                    type="button"
                    onContextMenu={(e) => {
                      e.preventDefault();
                      handleStartRenameGroup(group.name);
                    }}
                    className="flex flex-1 items-center gap-2 text-left"
                  >
                    <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                      {group.name}
                    </span>
                    <span className="text-xs text-zinc-600">({group.items.length})</span>
                  </button>
                )}
              </div>

              <div
                className={`grid transition-all duration-[280ms] ${
                  isCollapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]'
                }`}
                style={{ transitionTimingFunction: 'cubic-bezier(0.32, 0.72, 0, 1)' }}
              >
                <div className="overflow-hidden">
                  <ul
                    className={`flex flex-col gap-2 transition-all duration-[220ms] ${
                      isCollapsed ? '-translate-y-1 opacity-0' : 'translate-y-0 opacity-100'
                    }`}
                    style={{
                      transitionTimingFunction: 'cubic-bezier(0.32, 0.72, 0, 1)',
                      transitionDelay: isCollapsed ? '0ms' : '50ms'
                    }}
                  >
                    {group.items.map((conn) => {
                    const busy = connectingId === conn.id;
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
                              </div>
                            </div>
                          </button>
                          {!isDebugConnection(conn.id) && <button
                            type="button"
                            data-nodrag
                            onClick={() => openEditForm(conn)}
                            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-zinc-400 active:bg-zinc-800"
                            aria-label={`编辑 ${conn.name}`}
                          >
                            <Pencil className="h-4 w-4" />
                          </button>}
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
              </div>
            </div>
          );
        })}
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
        // 浮层保存后即关闭，它自己那条提示活不到用户看见；交给本页这条既有红条说。
        onSecretSaveError={setLocalError}
      />

      {/* Delete confirm sheet */}
      <MobileSheet
        open={deleteTarget != null}
        onClose={() => setDeleteTarget(null)}
        title="确认删除"
      >
        <div className="flex flex-col gap-2 px-4 pb-4">
          <p className="pb-1 text-sm text-zinc-400">
            删除连接「{deleteTargetLabel}」？此操作不可撤销。
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
