import { memo, useCallback, useEffect, useRef, useState } from 'react';
import ContextMenu from '@/components/ui/ContextMenu';
import MobileSheet from '@/mobile/ui/MobileSheet';
import { buildTurnTranscript, formatTurnElapsed, type TurnFooter } from '@/lib/turnTranscript';
import { getErrorMessage } from '@/lib/errors';

type CopyScope = 'reply' | 'task';
type CopyStatus = 'idle' | 'copied' | 'failed';

/** 菜单两项的文案（桌面菜单与手机面板共用，别各写一份）。 */
const COPY_OPTIONS: ReadonlyArray<{ scope: CopyScope; label: string; description: string }> = [
  { scope: 'reply', label: '复制最后一条回复', description: '只复制模型说的最后一段话' },
  { scope: 'task', label: '复制整个任务', description: '含工具调用与返回，不含思考过程' },
];

/** 桌面菜单的估算尺寸：只用来决定朝上还是朝下弹、横向别越界，差几像素无妨。 */
const MENU_WIDTH = 224;
const MENU_HEIGHT = 112;

type ForkStatus = 'idle' | 'working' | 'failed';

interface Props {
  footer: TurnFooter;
  /** 写剪贴板；失败请直接抛出，这里负责告诉用户「没复制成功」。 */
  onCopyText: (text: string) => void | Promise<void>;
  /**
   * 从这个任务收尾处分叉出新会话（参数 = 本任务最后一条回复的消息 id）。成功后调用方会把界面
   * 切到分叉里，本组件随之卸载；失败请直接抛出，这里负责告诉用户「没分叉成功」。
   * 不传 = 不显示分叉按钮。
   */
  onFork?: (messageId: string) => void | Promise<void>;
  /** 触屏端：无 hover → 条常显，选项走底部面板而不是浮层菜单。 */
  mobile?: boolean;
}

/**
 * 任务收尾条：挂在任务里模型说的最后一段话下面，左边是「复制」，右边是本任务用时。
 *
 * 观感对齐用户消息下面的「时间 + 撤回 + 复制」：桌面鼠标移到这条消息上才浮现、
 * 触屏常显。**必须挂在一个 `group/turn` 祖先下面**（由 `AgentMessageList` 的消息行
 * 提供），hover 的范围就是整条消息，不是这一小条 —— 否则用户得先瞄准一个看不见的
 * 按钮才能让它出现。
 *
 * 复制是个小菜单而不是两个并排图标：两项是同一个动作的两种范围，并排会让条上
 * 一下多出两个长得差不多的图标，用户得猜哪个是哪个。
 *
 * 注意：按钮**不能**带 `aria-expanded` —— 消息列表把任何 `button[aria-expanded]`
 * 的点击当成「折叠/展开」，会因此取消贴底跟随并记录折叠锚点。
 */
function TurnActions({ footer, onCopyText, onFork, mobile = false }: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number; anchor: 'below' | 'above' } | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [status, setStatus] = useState<CopyStatus>('idle');
  const [forkStatus, setForkStatus] = useState<ForkStatus>('idle');
  const [forkError, setForkError] = useState('');
  const resetTimer = useRef<number | null>(null);
  const forkResetTimer = useRef<number | null>(null);
  const mounted = useRef(true);

  useEffect(
    () => () => {
      mounted.current = false;
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
      if (forkResetTimer.current !== null) window.clearTimeout(forkResetTimer.current);
    },
    [],
  );

  const runFork = useCallback(async () => {
    if (!onFork || forkStatus === 'working') return;
    setForkStatus('working');
    try {
      await onFork(footer.messageId);
      // 成功时调用方已把界面切到分叉、这条收尾条多半已卸载；没卸载（比如切换被别的
      // 操作抢占）就回到初始状态，别一直卡在「分叉中」。
      if (mounted.current) setForkStatus('idle');
    } catch (err) {
      console.error('Failed to fork conversation:', err);
      if (!mounted.current) return;
      setForkError(getErrorMessage(err));
      setForkStatus('failed');
      if (forkResetTimer.current !== null) window.clearTimeout(forkResetTimer.current);
      forkResetTimer.current = window.setTimeout(() => {
        setForkStatus('idle');
        forkResetTimer.current = null;
      }, 2600);
    }
  }, [onFork, forkStatus, footer.messageId]);

  const closeMenu = useCallback(() => setMenu(null), []);

  // 菜单是 fixed 定位的：列表一滚动、窗口一变化它就会悬在错误的位置，直接收起。
  // Esc 同理。（桌面菜单的点击外部收起由 ContextMenu 自己管。）
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    const close = () => setMenu(null);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menu]);

  const run = useCallback(
    async (scope: CopyScope) => {
      const reply = footer.turn.find((m) => m.id === footer.messageId);
      const text = scope === 'reply' ? (reply?.content ?? '') : buildTurnTranscript(footer.turn);
      let next: CopyStatus = 'copied';
      try {
        await onCopyText(text);
      } catch (err) {
        console.error('Failed to copy:', err);
        next = 'failed';
      }
      setStatus(next);
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => {
        setStatus('idle');
        resetTimer.current = null;
      }, 1300);
    },
    [footer, onCopyText],
  );

  const onButtonClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    // 不让这次点击冒泡到 window：桌面菜单靠 window 的 click 收起，同一次点击会把
    // 刚打开的菜单立刻关掉。
    e.stopPropagation();
    if (mobile) {
      setSheetOpen(true);
      return;
    }
    if (menu) {
      setMenu(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom >= MENU_HEIGHT + 8;
    // 朝上弹时用菜单的下边缘贴住按钮（anchor=above），不靠估算高度去推上边缘 ——
    // 估算差几像素，菜单和按钮之间就多出一截缝。
    setMenu({
      x: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8)),
      y: below ? rect.bottom + 4 : rect.top - 4,
      anchor: below ? 'below' : 'above',
    });
  };

  const forcedVisible = menu !== null || sheetOpen || status !== 'idle' || forkStatus !== 'idle';
  const visibility = mobile || forcedVisible
    ? 'opacity-100 translate-y-0'
    : 'opacity-0 translate-y-1 group-hover/turn:opacity-100 group-hover/turn:translate-y-0';
  const label =
    status === 'copied' ? '已复制' : status === 'failed' ? '复制失败' : '复制';

  return (
    <div
      data-testid="turn-actions"
      className={`mt-1 flex w-max max-w-full items-center gap-2 text-[11px] text-zinc-500 transition-[background-color,border-color,color,opacity,transform] duration-150 focus-within:opacity-100 focus-within:translate-y-0 ${visibility}`}
    >
      <button
        type="button"
        onClick={onButtonClick}
        aria-haspopup="menu"
        aria-label={label}
        title={label}
        className="flex items-center gap-0.5 rounded p-1 text-zinc-500 transition-colors hover:bg-state-soft hover:text-zinc-200"
      >
        <span className="relative block h-3.5 w-3.5">
          <svg
            className={`absolute inset-0 h-3.5 w-3.5 transition-[opacity,transform] duration-120 ${
              status === 'idle' ? 'scale-100 opacity-100' : 'scale-50 opacity-0'
            }`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
            />
          </svg>
          <svg
            className={`absolute inset-0 h-3.5 w-3.5 text-green-400 transition-[opacity,transform] duration-120 ${
              status === 'copied' ? 'scale-100 opacity-100' : 'scale-50 opacity-0'
            }`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <svg
            className={`absolute inset-0 h-3.5 w-3.5 text-red-400 transition-[opacity,transform] duration-120 ${
              status === 'failed' ? 'scale-100 opacity-100' : 'scale-50 opacity-0'
            }`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </span>
        <svg
          className="h-2.5 w-2.5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {onFork && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void runFork();
          }}
          disabled={forkStatus === 'working'}
          aria-label="分叉会话"
          title={
            forkStatus === 'failed'
              ? forkError
              : '从这里分叉出一个新会话继续：原会话保持不变，随时可以回来'
          }
          data-testid="turn-fork"
          className={`flex items-center gap-1 rounded p-1 transition-colors hover:bg-state-soft disabled:cursor-wait ${
            forkStatus === 'failed' ? 'text-red-400' : 'text-zinc-500 hover:text-zinc-200'
          }`}
        >
          <svg
            className={`h-3.5 w-3.5 ${forkStatus === 'working' ? 'animate-pulse' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 3v12m0 0a3 3 0 103 3 3 3 0 00-3-3zm12-6a3 3 0 10-3-3 3 3 0 003 3zm0 0a9 9 0 01-9 9"
            />
          </svg>
          <span>{forkStatus === 'working' ? '分叉中…' : forkStatus === 'failed' ? '分叉失败' : '分叉'}</span>
        </button>
      )}

      {footer.elapsedMs !== null && (
        <span className="min-w-0 truncate" data-testid="turn-elapsed">
          用时 {formatTurnElapsed(footer.elapsedMs)}
        </span>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          anchor={menu.anchor}
          onClose={closeMenu}
          items={COPY_OPTIONS.map((option) => ({
            label: option.label,
            description: option.description,
            onClick: () => void run(option.scope),
          }))}
        />
      )}

      {mobile && (
        <MobileSheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="复制">
          <div className="space-y-1 px-2 pb-3">
            {COPY_OPTIONS.map((option) => (
              <button
                key={option.scope}
                type="button"
                onClick={() => {
                  setSheetOpen(false);
                  void run(option.scope);
                }}
                className="flex min-h-12 w-full flex-col items-start justify-center rounded-xl px-3 py-2 text-left active:bg-state-mid"
              >
                <span className="text-[15px] text-zinc-100">{option.label}</span>
                <span className="text-xs text-zinc-500">{option.description}</span>
              </button>
            ))}
          </div>
        </MobileSheet>
      )}
    </div>
  );
}

export default memo(TurnActions);
