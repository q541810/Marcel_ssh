import { useState, type MouseEvent } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { useConnectionStore } from '@/stores/connectionStore';
import { useTaskStore } from '@/stores/taskStore';
import { getSessionAgentStatus } from '@/stores/agentStatusSelectors';
import { AgentStatusIndicator } from '@/components/agent/AgentStatusIndicator';
import { useSessionLifecycle } from '@/hooks/useSessionLifecycle';
import { useHostKeyMismatch } from '@/hooks/useHostKeyMismatch';
import { useConnectWithPassword } from '@/hooks/useConnectWithPassword';
import { usePrivacyMode } from '@/hooks/usePrivacyMode';
import { asHostKeyMismatch, getErrorMessage, parseAppError } from '@/lib/errors';
import { isPasswordRejected } from '@/lib/privateKey';
import { recoverConnectionAuth } from '@/lib/connectionAuth';
import StatusDot from '@/components/connection/StatusDot';
import { RefreshCw, X } from 'lucide-react';
import RemotePlatformBadge from '@/components/connection/RemotePlatformBadge';
import type { SavedConnection } from '@/lib/types';

export default function TabBar() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const disconnect = useSessionStore((s) => s.disconnect);
  const reconnect = useSessionStore((s) => s.reconnect);
  const connections = useConnectionStore((s) => s.connections);
  const tasks = useTaskStore((s) => s.tasks);
  const unreadCompletedConversations = useTaskStore(
    (s) => s.unreadCompletedConversations,
  );
  const { onDisconnected } = useSessionLifecycle();
  const mismatch = useHostKeyMismatch();
  const privacyMode = usePrivacyMode();
  const { prompt: promptPassword, Prompt: PasswordPromptEl } =
    useConnectWithPassword();
  /**
   * 重连本身留下的提示（无法就地补救时才有值）。
   *
   * 标签栏没有别的报错面：失败详情由 sessionStore 打进那条会话的终端横幅，但用户
   * 点「重连」时看的往往是另一条标签，横幅在别处。这里补一条最轻的、与连接列表
   * 同款的红条，只装"你下一步该去哪"。
   */
  const [reconnectNotice, setReconnectNotice] = useState<string | null>(null);

  const sessionList = Object.values(sessions);

  if (sessionList.length === 0) {
    return null;
  }

  const baseLabelOf = (session: (typeof sessionList)[number]) => {
    const saved = session.configId ? connections.find((c) => c.id === session.configId) : null;
    return saved?.name || session.connectionId || '未命名';
  };

  /** 这条会话对应的已保存连接；拿不到就没法就地补密码（记录被删 / 列表还没载入）。 */
  const savedConnectionOf = (sessionId: string): SavedConnection | undefined => {
    const configId = sessionList.find((s) => s.id === sessionId)?.configId;
    return configId ? connections.find((c) => c.id === configId) : undefined;
  };

  const labelCounts: Record<string, number> = {};
  for (const s of sessionList) {
    const l = baseLabelOf(s);
    labelCounts[l] = (labelCounts[l] || 0) + 1;
  }

  const dupSeen: Record<string, number> = {};
  const dupIndex: Record<string, number> = {};
  sessionList
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .forEach((s) => {
      const l = baseLabelOf(s);
      if (labelCounts[l] > 1) {
        const idx = dupSeen[l] || 0;
        dupSeen[l] = idx + 1;
        dupIndex[s.id] = idx;
      }
    });

  /**
   * 重连（含主机密钥确认后的重试）。失败一律回到这里处理，两条路共用同一套判据。
   */
  const runReconnect = (sessionId: string, trust = false): Promise<void> => {
    setReconnectNotice(null);
    return reconnect(sessionId, trust).catch((err) => {
      const m = asHostKeyMismatch(parseAppError(err));
      if (m) {
        mismatch.prompt({
          data: m,
          onTrust: () => runReconnect(sessionId, true),
        });
        return;
      }
      const saved = savedConnectionOf(sessionId);
      if (saved && recoverConnectionAuth({
        error: err, connection: saved, privacyMode, prompt: promptPassword,
        retry: () => runReconnect(sessionId, trust),
        onSaveError: (saveErr) => setReconnectNotice(
          `新密码没能保存到本设备（${getErrorMessage(saveErr)}），请到连接列表里重新设置后重连。`,
        ),
      })) return;
      console.error('重连失败:', err);
      if (isPasswordRejected(err)) {
        // 凭据被拒，但拿不到这条连接的记录（已被删除 / 列表还没载入）→ 就地补不了，
        // 只能把去处说清楚。
        setReconnectNotice(
          `重连失败：${getErrorMessage(err)}。到连接列表里重新设置密码或检查私钥，然后重试。`,
        );
      }
    });
  };

  const handleReconnect = (sessionId: string, e: MouseEvent) => {
    e.stopPropagation();
    runReconnect(sessionId);
  };

  return (
    <>
      {reconnectNotice && (
        <div
          role="alert"
          className="flex items-start justify-between gap-2 border-b border-red-900/50 bg-red-950/40 px-3 py-1.5 text-meta leading-relaxed text-red-300"
        >
          <span>{reconnectNotice}</span>
          <button
            type="button"
            onClick={() => setReconnectNotice(null)}
            className="shrink-0 text-red-400/70 hover:text-red-200"
            aria-label="关闭提示"
          >
            &times;
          </button>
        </div>
      )}
      <div className="flex items-end bg-surface-sunken overflow-x-auto pt-1 px-1">
        <div className="flex items-end gap-0.5">
          {sessionList.map((session) => {
            const isActive = session.id === activeSessionId;
            const base = baseLabelOf(session);
            const label = labelCounts[base] > 1 ? `${base}:${dupIndex[session.id]}` : base;
            const canReconnect =
              (session.status === 'disconnected' || session.status === 'error') &&
              Boolean(session.configId);
            const showReconnectHint =
              session.status === 'disconnected' || session.status === 'error';

            return (
              <div
                key={session.id}
                onClick={() => setActiveSession(session.id)}
                className={`
                  group flex h-7 items-center gap-2 px-3 text-body cursor-pointer
                  rounded-t-lg min-w-0 max-w-[180px]
                  transition-colors
                  ${
                    isActive
                      ? 'bg-surface text-fg'
                      : 'text-fg-secondary hover:bg-state-soft hover:text-fg'
                  }
                `}
              >
                {/* Status dot */}
                <StatusDot status={session.status} />
                {/* Label */}
                <span className="truncate flex-1">{label}</span>

                <RemotePlatformBadge
                  compact
                  platform={
                    session.remotePlatform ??
                    savedConnectionOf(session.id)?.remotePlatform
                  }
                />

                {/* Agent Activity Status (OpenCode style Spinner / Amber dot / Emerald dot) */}
                <AgentStatusIndicator
                  status={getSessionAgentStatus(
                    session.id,
                    tasks,
                    unreadCompletedConversations,
                  )}
                  size="xs"
                  showTooltip
                />

                {/* Reconnect on disconnected/error */}
                {showReconnectHint && (
                  <button
                    type="button"
                    onClick={(e) => {
                      if (!canReconnect) {
                        e.stopPropagation();
                        return;
                      }
                      handleReconnect(session.id, e);
                    }}
                    disabled={!canReconnect || session.status === 'connecting'}
                    className={`
                      h-5 w-5 inline-flex items-center justify-center rounded-md flex-shrink-0
                      transition-colors pressable focus-ring
                      ${
                        canReconnect
                          ? 'text-fg-secondary hover:bg-state-mid hover:text-emerald-400'
                          : 'text-fg-disabled cursor-not-allowed'
                      }
                    `}
                    title={
                      canReconnect
                        ? '重新连接'
                        : '临时连接无法自动重连，请去侧边栏重新连接'
                    }
                  >
                    <RefreshCw size={14} strokeWidth={1.5} />
                  </button>
                )}

                {/* Close button */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    const configId = session.configId;
                    const sid = session.id;
                    disconnect(sid).then(() => {
                      if (configId) {
                        onDisconnected(configId, sid);
                      }
                    });
                  }}
                  className="
                    opacity-0 group-hover:opacity-100 focus-visible:opacity-100
                    h-5 w-5 inline-flex items-center justify-center rounded-md hover:bg-state-mid text-fg-tertiary hover:text-fg
                    transition-opacity flex-shrink-0 pressable focus-ring
                  "
                  title="关闭会话"
                >
                  <X size={14} strokeWidth={1.5} />
                </button>
              </div>
            );
          })}
        </div>
      </div>
      {mismatch.Modal}
      {PasswordPromptEl}
    </>
  );
}
