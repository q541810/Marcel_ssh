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
import { formatConnLabel } from '@/lib/privacy';
import type { SavedConnection } from '@/lib/types';
import * as tauri from '@/lib/tauri';

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
  const runReconnect = (sessionId: string, trust = false) => {
    setReconnectNotice(null);
    reconnect(sessionId, trust).catch((err) => {
      const m = asHostKeyMismatch(parseAppError(err));
      if (m) {
        mismatch.prompt({
          data: m,
          onTrust: () => runReconnect(sessionId, true),
        });
        return;
      }
      // 存的那份密码被服务器拒了：`ssh_reconnect` 每次都从密钥链取回**同一份**密码
      // 重放，不换一份的话点多少次「重连」都是同一个结果，且没有任何解释。这里就地
      // 复问（与连接列表里"存的那份被拒 → 换一份"同一口径），新密码覆盖密钥链里
      // 那份错的，再用它重连。
      //
      // 只在这条连接确实是密码认证时才追问：同一个原因码在私钥流程里表示"这把密钥
      // 被拒"，那时要密码是答非所问（见 `src/lib/privateKey.ts`）。刻意不做两件事：
      // 不加"记住"复选框、不做"先验后存"——都是既定的产品决策。
      const saved = savedConnectionOf(sessionId);
      if (saved?.authMethod === 'Password' && isPasswordRejected(err)) {
        promptPassword({
          title: 'SSH 密码',
          description:
            `重连 ${formatConnLabel(saved.username, saved.host, saved.port, privacyMode)}。` +
            '上次保存的密码被服务器拒绝，请输入新的；输入后会覆盖本机保存的那份。',
          onSubmit: async (password) => {
            try {
              await tauri.savePassword(saved.id, password);
            } catch (saveErr) {
              console.warn('保存密码到密钥链失败:', saveErr);
              // 没能覆盖那份错的 → 重连只会继续重放旧密码，别再骗用户点一次
              setReconnectNotice(
                `新密码没能保存到本设备（${getErrorMessage(saveErr)}），重连仍会使用旧密码。请到连接列表里重新设置这条连接的密码。`,
              );
              return;
            }
            runReconnect(sessionId);
          },
        });
        return;
      }
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
          className="flex items-start justify-between gap-2 border-b border-red-900/50 bg-red-950/40 px-3 py-1.5 text-xs leading-relaxed text-red-300"
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
      <div className="flex items-center bg-zinc-900 border-b border-zinc-800 overflow-x-auto">
        <div className="flex items-center">
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
                  group flex items-center gap-2 px-3 py-2 text-xs cursor-pointer
                  border-r border-zinc-800 min-w-0 max-w-[180px]
                  transition-colors
                  ${
                    isActive
                      ? 'bg-zinc-800 text-zinc-100'
                      : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
                  }
                `}
              >
                {/* Status dot */}
                <span
                  className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                    session.status === 'connected'
                      ? 'bg-emerald-500'
                      : session.status === 'connecting'
                        ? 'bg-amber-500 animate-pulse'
                        : session.status === 'error'
                          ? 'bg-red-500'
                          : 'bg-zinc-600'
                  }`}
                />

                {/* Label */}
                <span className="truncate flex-1">{label}</span>

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
                      p-0.5 rounded flex-shrink-0
                      transition-colors
                      ${
                        canReconnect
                          ? 'text-zinc-400 hover:bg-zinc-700 hover:text-emerald-400'
                          : 'text-zinc-600 cursor-not-allowed'
                      }
                    `}
                    title={
                      canReconnect
                        ? '重新连接'
                        : '临时连接无法自动重连，请去侧边栏重新连接'
                    }
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                      />
                    </svg>
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
                    opacity-0 group-hover:opacity-100
                    p-0.5 rounded hover:bg-zinc-700 text-zinc-500 hover:text-zinc-200
                    transition-opacity flex-shrink-0
                  "
                  title="关闭会话"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
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
