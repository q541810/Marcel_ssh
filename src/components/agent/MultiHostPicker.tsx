import { useMemo, useRef, useState, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useSettingsStore } from '@/stores/settingsStore';
import { useConnectionStore } from '@/stores/connectionStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useAnimatedPresence } from '@/hooks/useAnimatedPresence';

/**
 * 多机操控「目标机器」选择器（Agent 面板顶栏，新建会话按钮左侧）。
 *
 * 语义（双端多机操控恒开启，无开关）：
 * - **当前机器**：顶部锁定区显示当前 SSH 会话所在机器，恒可被 Agent 执行
 *   （不传 host 或 host=当前机都打在这台）；随会话切换自动跟随，不可取消。
 * - **可跨机目标**：分割线下多选，数据 = experimentalSettings.multiHostConnectionIds
 *   （SavedConnection id 列表，与后端白名单同一份——后端 host 解析只认它）。
 *   勾选即时持久化（update → 落盘 settings）。
 * - 集合为空 = 无可跨机目标，Agent 只能操作当前机；后端对集合外 host 拒绝。
 *
 * 弹窗定位（与 ModelPicker 同款）：`createPortal` 到 body + fixed 定位 +
 * 视口钳制——Agent 面板有 overflow 祖先，absolute 下拉会被裁剪/超出视口。
 * 按钮在顶栏（面板顶部），打开时按「按钮上下两侧可用高度」自动选择展开方向：
 * 上方空间大向上弹、否则向下，且左/宽钳制在视口内。
 */
export default function MultiHostPicker() {
  const connections = useConnectionStore((s) => s.connections);
  const fetchConnections = useConnectionStore((s) => s.fetchConnections);
  const experimental = useSettingsStore((s) => s.settings.experimentalSettings);
  const update = useSettingsStore((s) => s.update);
  const activeSession = useSessionStore((s) =>
    s.activeSessionId ? (s.sessions[s.activeSessionId] ?? null) : null,
  );

  const [open, setOpen] = useState(false);
  const presence = useAnimatedPresence(open);
  const rootRef = useRef<HTMLDivElement>(null);
  /** 弹窗本体 ref：portal 到 body 后用于点击外部关闭判断。 */
  const popoverRef = useRef<HTMLDivElement>(null);
  /** 弹窗 fixed 定位参数：打开时按触发按钮位置 + 视口钳制计算。 */
  const [pos, setPos] = useState<{
    /** upward：fixed bottom（底边锚定按钮顶上方 MARGIN）；downward：fixed top。 */
    top: number | null;
    bottom: number | null;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  // 当前会话所在机器：已保存连接（configId → connection），临时连接无名字。
  const currentConn = useMemo(() => {
    if (!activeSession?.configId) return null;
    return (
      connections.find((c) => c.id === activeSession.configId) ?? null
    );
  }, [activeSession?.configId, connections]);

  // 展示/计数用集合：剔除当前机 id（当前机在顶部锁定区，不参与集合数据）。
  const selected = useMemo(
    () => (experimental?.multiHostConnectionIds ?? []).filter(
      (id) => id !== activeSession?.configId,
    ),
    [experimental?.multiHostConnectionIds, activeSession?.configId],
  );

  // 首次打开确保连接列表已加载（勾选来源）。
  useEffect(() => {
    if (connections.length === 0) void fetchConnections();
  }, [connections.length, fetchConnections]);

  // 点外部关闭下拉（portal 到 body：按钮容器与弹窗本体都算内部）。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // 打开时测量触发按钮位置，把弹窗钳制在视口内并选择展开方向：
  // - fixed 定位可避免被 agent 面板的 overflow 祖先裁剪（窄面板下右缘/底缘
  //   超出即被裁掉，导致内容看不见）
  // - 方向：按钮上方可用高度 ≥ 下方时向上展开（fixed bottom 锚定按钮顶上方），
  //   否则向下（fixed top 锚定按钮底下方）——顶栏按钮可能贴近窗口顶/消息区，
  //   自适应避免出界；fixed 只用 top 或 bottom 其一，另一侧交给内容 + maxHeight
  // - useLayoutEffect 同步测量：打开首帧即定位，避免弹窗闪现
  // - 关闭时不清 pos：退出动画期间保留原位置播放
  useLayoutEffect(() => {
    if (!open) return;
    const btn = rootRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const MARGIN = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.max(240, Math.min(320, vw - MARGIN * 2));
    const left = Math.max(MARGIN, Math.min(rect.left, vw - MARGIN - width));
    const spaceBelow = vh - rect.bottom - MARGIN;
    const spaceAbove = rect.top - MARGIN;
    const upward = spaceAbove >= spaceBelow;
    // 展开方向可用高度：该方向空间（保底 160px），弹窗内部还有标题/说明等
    // 固定区，列表 flex-1 收缩滚动，故 maxHeight 取整段可用高度
    const maxHeight = Math.max(160, (upward ? spaceAbove : spaceBelow));
    setPos({
      // 只设一侧：upward 时 bottom = 视口底 - 按钮顶 + MARGIN（弹窗底边贴
      // 按钮顶上方），top 置 null；downward 时 top = 按钮底 + MARGIN，bottom
      // 置 null。配合 fixed + maxHeight，另一方向由内容决定不会出界。
      top: upward ? null : rect.bottom + MARGIN,
      bottom: upward ? vh - rect.top + MARGIN : null,
      left,
      width,
      maxHeight,
    });
  }, [open]);

  const toggle = (id: string) => {
    // 当前机不参与集合数据：防御性剔除。
    if (id === activeSession?.configId) return;
    const next = selected.includes(id)
      ? selected.filter((x) => x !== id)
      : [...selected, id];
    // settingsStore 在启动/磁盘读取时总会 merge 默认值，运行时 experimental
    // 实际非空；此处展开兜底（enableWebSearch 等必填字段给保守默认），
    // 保证即使旧配置缺省也能构造完整对象落盘。
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

  // 跨机目标候选 = 全部已保存连接，剔除当前机（锁定区已展示）。
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

  const isCurrentOnline = activeSession?.status === 'connected';
  const currentLabel = currentConn?.name ?? activeSession?.connectionId ?? '';
  const disabled = !currentLabel;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => {
          if (disabled) return;
          setOpen((v) => !v);
        }}
        disabled={disabled}
        className={[
          'group flex h-7 max-w-[11rem] items-center gap-1.5 rounded-lg border px-2 text-xs font-medium',
          'transition-all duration-150 active:scale-[0.97]',
          disabled
            ? 'cursor-not-allowed border-zinc-800 text-zinc-600'
            : open
              ? 'border-indigo-500/50 bg-indigo-500/10 text-indigo-200'
              : 'border-transparent text-zinc-400 hover:border-zinc-700 hover:bg-zinc-800/70 hover:text-zinc-200',
        ].join(' ')}
        title={
          currentLabel
            ? selected.length > 0
              ? `当前机器 ${currentLabel} · 可跨机目标 ${selected.length} 台`
              : `当前机器 ${currentLabel} · 点击勾选可跨机的目标机器`
            : '未连接服务器，连接后可指定目标机器'
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
          <span
            className={`flex h-4 min-w-4 flex-shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none ${
              disabled
                ? 'bg-zinc-700 text-zinc-500'
                : 'bg-indigo-500 text-white'
            }`}
          >
            {selected.length}
          </span>
        )}
        <svg
          className={`h-3 w-3 flex-shrink-0 transition-transform duration-200 ${
            open ? 'rotate-180' : ''
          }`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {presence.mounted &&
        pos &&
        createPortal(
          <div
            ref={popoverRef}
            onAnimationEnd={presence.onAnimationEnd}
            style={{
              left: pos.left,
              width: pos.width,
              maxHeight: pos.maxHeight,
              ...(pos.top !== null && pos.top !== undefined
                ? { top: pos.top }
                : { bottom: pos.bottom ?? 0 }),
            }}
            className={`fixed z-[100] flex flex-col overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-800/95 shadow-2xl backdrop-blur-md ${
              presence.phase === 'exit'
                ? 'mobile-popover-exit'
                : 'mobile-popover-enter'
            }`}
          >
          {/* ── 标题 ── */}
          <div className="flex items-center justify-between border-b border-zinc-700/60 px-3 py-2">
            <span className="text-xs font-semibold text-zinc-200">目标机器</span>
            <span className="text-[10px] text-zinc-500">
              当前机 + {selected.length} 台可跨机
            </span>
          </div>

          {/* ── 当前机器（锁定） ── */}
          <div className="px-1.5 pt-1.5">
            <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-2.5 py-2">
              <div className="flex items-center gap-2">
                <svg
                  className="h-4 w-4 flex-shrink-0 text-indigo-300"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 12h14M12 5l7 7-7 7"
                  />
                </svg>
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
                <svg
                  className="h-3.5 w-3.5 flex-shrink-0 text-indigo-300/60"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                  />
                </svg>
              </div>
              <p className="mt-1.5 text-[10px] leading-relaxed text-indigo-200/60">
                Agent 默认在这台机器上执行；始终可用，无需勾选。
              </p>
            </div>
          </div>

          {/* ── 可跨机目标 ── */}
          <div className="px-3 pb-1 pt-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                可跨机目标
              </span>
              <span className="text-[10px] text-zinc-600">
                勾选后 Agent 可携 host 操作
              </span>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
            {others.length === 0 && (
              <div className="px-2 py-4 text-center text-xs text-zinc-500">
                暂无其他已保存连接，请先在连接列表添加机器
              </div>
            )}
            {others.map((conn) => {
              const active = selected.includes(conn.id);
              return (
                <button
                  key={conn.id}
                  type="button"
                  onClick={() => toggle(conn.id)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-100 active:scale-[0.99] ${
                    active
                      ? 'bg-indigo-500/10 text-indigo-100'
                      : 'text-zinc-300 hover:bg-zinc-700/50'
                  }`}
                >
                  <span
                    className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border transition-colors duration-100 ${
                      active
                        ? 'border-indigo-400 bg-indigo-500'
                        : 'border-zinc-600 bg-transparent'
                    }`}
                  >
                    {active && (
                      <svg
                        className="h-2.5 w-2.5 scale-in text-white"
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

          <div className="border-t border-zinc-700/60 bg-zinc-900/40 px-3 py-2 text-[10px] leading-relaxed text-zinc-500">
            Agent 的 bash / 传输 / 子agent 可用 host 指定这些机器；未勾选的不在
            集合内，即使在线也会被拒绝。当前机器始终可执行。
          </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
