import { useEffect, useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useConnectionStore } from '@/stores/connectionStore';
import { useSessionStore } from '@/stores/sessionStore';
import MobileSheet from './ui/MobileSheet';
import { registerBackHandler } from './backHandler';

/**
 * 多机操控「目标机器」选择器（移动端 Agent 顶栏）。
 *
 * 语义与桌面 MultiHostPicker 对齐（双端多机恒开启，无总开关）：
 * - 当前机器：顶部锁定，始终可被 Agent 执行，无需勾选。
 * - 可跨机目标：多选，写 experimentalSettings.multiHostConnectionIds
 *   （与后端白名单同一份）。
 * - 集合为空 = 仅当前机；后端对集合外 host 拒绝。
 */
export default function MobileMultiHostPicker({
  disabled = false,
}: {
  disabled?: boolean;
}) {
  const connections = useConnectionStore((s) => s.connections);
  const fetchConnections = useConnectionStore((s) => s.fetchConnections);
  const experimental = useSettingsStore((s) => s.settings.experimentalSettings);
  const update = useSettingsStore((s) => s.update);
  const activeSession = useSessionStore((s) =>
    s.activeSessionId ? (s.sessions[s.activeSessionId] ?? null) : null,
  );
  const [open, setOpen] = useState(false);

  const currentConn = useMemo(() => {
    if (!activeSession?.configId) return null;
    return connections.find((c) => c.id === activeSession.configId) ?? null;
  }, [activeSession?.configId, connections]);

  const selected = useMemo(
    () =>
      (experimental?.multiHostConnectionIds ?? []).filter(
        (id) => id !== activeSession?.configId,
      ),
    [experimental?.multiHostConnectionIds, activeSession?.configId],
  );

  useEffect(() => {
    if (open && connections.length === 0) void fetchConnections();
  }, [open, connections.length, fetchConnections]);

  useEffect(() => {
    if (!open) return;
    return registerBackHandler(() => setOpen(false));
  }, [open]);

  const toggle = (id: string) => {
    if (id === activeSession?.configId) return;
    const next = selected.includes(id)
      ? selected.filter((x) => x !== id)
      : [...selected, id];
    void update({
      experimentalSettings: {
        enableWebSearch: true,
        enableHttpFetch: true,
        enableCloudPage: false,
        enableHtmlRender: true,
        ...experimental,
        multiHostConnectionIds: next,
      },
    });
  };

  const others = useMemo(
    () =>
      connections
        .filter((c) => c.id !== activeSession?.configId)
        .sort(
          (a, b) =>
            (a.group || '').localeCompare(b.group || '') ||
            a.name.localeCompare(b.name),
        ),
    [connections, activeSession?.configId],
  );

  const currentLabel = currentConn?.name ?? activeSession?.connectionId ?? '';
  const isCurrentOnline = activeSession?.status === 'connected';
  const buttonDisabled = disabled || !currentLabel;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (buttonDisabled) return;
          setOpen(true);
        }}
        disabled={buttonDisabled}
        className={[
          'flex min-w-0 max-w-[7.5rem] items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium transition-all active:scale-95',
          buttonDisabled
            ? 'cursor-not-allowed border-zinc-800 text-zinc-600'
            : selected.length > 0
              ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-200'
              : 'border-zinc-700/80 bg-zinc-900/60 text-zinc-300',
        ].join(' ')}
        title={
          currentLabel
            ? selected.length > 0
              ? `当前机器 ${currentLabel} · 可跨机目标 ${selected.length} 台`
              : `当前机器 ${currentLabel} · 点击勾选可跨机目标`
            : '未连接服务器'
        }
      >
        <span
          className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
            isCurrentOnline ? 'bg-emerald-400' : 'bg-zinc-600'
          }`}
        />
        <span className="min-w-0 flex-1 truncate">
          {currentLabel || '未连接'}
        </span>
        {selected.length > 0 && (
          <span className="flex h-4 min-w-4 flex-shrink-0 items-center justify-center rounded-full bg-indigo-500 px-1 text-[10px] font-semibold leading-none text-white">
            {selected.length}
          </span>
        )}
        <ChevronDown className="h-3 w-3 flex-shrink-0 opacity-70" />
      </button>

      <MobileSheet
        open={open}
        onClose={() => setOpen(false)}
        title={
          <div className="flex w-full items-center justify-between pr-6">
            <span>目标机器</span>
            <span className="text-[11px] font-normal text-zinc-500">
              当前机 + {selected.length} 台可跨机
            </span>
          </div>
        }
        maxHeightClassName="max-h-[75dvh]"
      >
        <div className="space-y-3 px-4 pb-4">
          <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-semibold text-indigo-100">
                    {currentLabel || '未连接服务器'}
                  </span>
                  <span className="flex h-[15px] flex-shrink-0 items-center rounded bg-indigo-500/25 px-1 text-[9px] font-semibold tracking-wide text-indigo-200">
                    当前
                  </span>
                </span>
                {currentConn ? (
                  <span className="mt-0.5 block truncate text-[10px] text-indigo-300/70">
                    {currentConn.group || '未分组'} · {currentConn.username}@
                    {currentConn.host}:{currentConn.port}
                  </span>
                ) : (
                  <span className="mt-0.5 block truncate text-[10px] text-indigo-300/70">
                    临时连接（未保存）· 仅当前机器可执行
                  </span>
                )}
              </span>
            </div>
            <p className="mt-1.5 text-[10px] leading-relaxed text-indigo-200/60">
              Agent 默认在这台机器上执行；始终可用，无需勾选。
            </p>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
              可跨机目标
            </span>
            <span className="text-[10px] text-zinc-600">
              勾选后 Agent 可携 host 操作
            </span>
          </div>

          {others.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-zinc-500">
              暂无其他已保存连接，请先在连接列表添加机器
            </div>
          ) : (
            <div className="space-y-1">
              {others.map((conn) => {
                const active = selected.includes(conn.id);
                return (
                  <button
                    key={conn.id}
                    type="button"
                    onClick={() => toggle(conn.id)}
                    className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-colors active:scale-[0.99] ${
                      active
                        ? 'bg-indigo-500/10 text-indigo-100'
                        : 'bg-zinc-900/50 text-zinc-300'
                    }`}
                  >
                    <span
                      className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border ${
                        active
                          ? 'border-indigo-400 bg-indigo-500'
                          : 'border-zinc-600 bg-transparent'
                      }`}
                    >
                      {active && (
                        <svg
                          className="h-2.5 w-2.5 text-white"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={3.5}
                            d="M5 13l4 4L19 7"
                          />
                        </svg>
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">
                        {conn.name}
                      </span>
                      <span className="block truncate text-[10px] text-zinc-500">
                        {conn.group || '未分组'} · {conn.username}@{conn.host}:
                        {conn.port}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <p className="text-[10px] leading-relaxed text-zinc-500">
            Agent 的 bash / 子agent 可用 host 指定这些机器；未勾选的不在集合内，
            即使在线也会被拒绝。当前机器始终可执行。
          </p>
        </div>
      </MobileSheet>
    </>
  );
}
