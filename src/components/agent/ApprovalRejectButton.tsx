import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * 审批的「拒绝」：主按钮就是普通拒绝，旁边一个小箭头里收着「拒绝并停止任务」。
 *
 * 「拒绝并停止」是少数情况（用户压根不想让 Agent 继续试），以前它作为一行小字常驻在
 * 底栏，占一整行；收进箭头后底栏能压成一行，但入口一步可达、文案不变。
 * 调用方不提供 `onRejectAndStop` 时只剩一个普通拒绝按钮（没有箭头）。
 * 桌面审批弹窗与手机审批底部面板共用。
 *
 * 键盘：弹窗的全局 Enter = 批准监听挂在 document 上，焦点落在这组按钮里时必须让它
 * 别抢 —— 否则焦点在菜单项上按 Enter 会变成「批准」。这里在组内拦下 Enter，让按钮
 * 照原生行为被激活。Esc 同理：菜单开着时先关菜单，不连带把整个弹窗收起。
 */
export function ApprovalRejectButton({
  onReject,
  onRejectAndStop,
  touch,
  className = '',
}: {
  onReject: () => void;
  onRejectAndStop?: () => void;
  /** 手机：更高的点击区、更大的圆角。 */
  touch?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const caretRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const shape = touch ? 'py-3 text-read' : 'py-1.5 text-read';
  const base =
    'inline-flex items-center justify-center bg-state-mid font-medium text-fg transition-colors hover:bg-state-strong active:bg-state-strong focus-ring';
  const radius = touch ? 'rounded-xl' : 'rounded-lg';

  return (
    <div
      ref={rootRef}
      className={`relative inline-flex ${className}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.stopPropagation();
        } else if (e.key === 'Escape' && open) {
          e.stopPropagation();
          e.preventDefault();
          setOpen(false);
          caretRef.current?.focus();
        }
      }}
    >
      <button
        type="button"
        onClick={onReject}
        className={`${base} ${shape} flex-1 px-3.5 ${onRejectAndStop ? (touch ? 'rounded-l-xl' : 'rounded-l-lg') : radius}`}
      >
        拒绝
      </button>
      {onRejectAndStop && (
        <>
          <button
            ref={caretRef}
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label="更多拒绝方式"
            aria-haspopup="menu"
            aria-expanded={open}
            className={`${base} ${touch ? 'px-3 py-3' : 'px-1.5 py-1.5'} ${touch ? 'rounded-r-xl' : 'rounded-r-lg'} border-l border-edge`}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          {open && (
            <div
              role="menu"
              className="animate-fadeIn absolute bottom-full right-0 z-20 mb-2 min-w-[11rem] origin-bottom-right rounded-xl surface-glass p-1"
            >
              <button
                type="button"
                role="menuitem"
                autoFocus
                onClick={() => {
                  setOpen(false);
                  onRejectAndStop();
                }}
                title="拒绝这次调用，并停止整个任务（Agent 不会再继续尝试）"
                className={`w-full rounded-lg px-3 text-left text-read text-red-300 transition-colors hover:bg-state-soft active:bg-state-mid focus-ring ${
                  touch ? 'py-3' : 'py-2'
                }`}
              >
                拒绝并停止任务
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
