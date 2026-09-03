import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAnimatedPresence } from '@/hooks/useAnimatedPresence';

/**
 * 会话级「思考强度」选择器（桌面端 / 移动端共用）。
 *
 * 触发按钮始终显示本会话**当前生效模型**的思考档位：该模型在本会话记过档
 * 位且档位在其 `reasoningEfforts` 声明内 → 显示该档位；未记 / 失效 →
 * 显示「默认」（= 不传 `reasoning_effort`，跟随模型自身默认）。
 *
 * 档位按「会话 × 模型」双维记忆（内存）：每个模型在会话里各自记档位，
 * 切到别的模型互不污染、切回原模型原档位仍在。弹窗只列当前生效模型
 * **声明**的档位 + 一个「默认（不传）」项，因此不会出现选不了/选了不生效。
 *
 * 父组件负责：仅在当前生效模型的声明档位非空时才渲染本组件（模型未声明
 * 思考强度 = 不参与选择，输入条不出现这个按钮，避免无意义/跳动 UI）。
 */
export function ReasoningEffortPicker({
  value,
  efforts,
  onChange,
  disabled,
  compact = false,
}: {
  /** 当前会话的档位字符串（null = 未设置，跟随模型默认）。 */
  value: string | null | undefined;
  /** 当前生效模型声明的可用档位（父组件已用 modelReasoningEfforts 归一化）。 */
  efforts: string[];
  /** 选档：档位字符串；null = 清除（跟随模型默认）。 */
  onChange: (effort: string | null) => void;
  disabled?: boolean;
  /** 紧凑模式（移动端/窄宽度时用）。 */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const presence = useAnimatedPresence(open);
  const [pos, setPos] = useState<{
    bottom: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  // 触发按钮文字：当前生效模型在本会话记过且档位有效 → 显示档位；否则「默认」
  const active = !!value && efforts.includes(value);
  const label = active ? value! : '默认';

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (containerRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    };
    if (open) document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // 定位逻辑与 ModelPicker 一致：fixed 底部锚定按钮顶、视口钳制、避免被
  // overflow-hidden 祖先裁剪。关闭时不清 pos，保留位置播放退出动画。
  useLayoutEffect(() => {
    if (!open) return;
    const btn = containerRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const MARGIN = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.max(160, Math.min(240, vw - MARGIN * 2));
    const left = Math.max(MARGIN, Math.min(rect.left, vw - MARGIN - width));
    const bottom = vh - rect.top + MARGIN;
    const maxHeight = Math.max(120, rect.top - MARGIN * 2);
    setPos({ bottom, left, width, maxHeight });
  }, [open]);

  return (
    // min-w-0 + 可收缩：与 ModelPicker 一致——工具栏空间不足时档位文字
    // 随可用宽度截断让位，不把右侧按钮顶出输入框
    <div ref={containerRef} className="relative min-w-0 self-center">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={`
          flex w-full min-w-0 items-center gap-1 rounded-full text-xs font-medium transition-colors
          ${
            open
              ? "bg-zinc-700 text-zinc-100"
              : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50"
          }
          ${compact ? "px-1.5 py-1.5" : "px-2 py-1.5"}
          disabled:opacity-40 disabled:cursor-not-allowed
        `}
        title="切换本会话思考强度（不传 = 跟随模型默认）"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {/* 当前档位文字：未选 = 默认，已选 = 档位值。状态即文字，无需图标。 */}
        <span className="truncate min-w-0 max-w-[5rem]">{label}</span>
      </button>

      {presence.mounted &&
        pos &&
        createPortal(
          <div
            ref={popoverRef}
            role="listbox"
            aria-label="思考强度"
            onAnimationEnd={presence.onAnimationEnd}
            style={{
              bottom: pos.bottom,
              left: pos.left,
              width: pos.width,
              maxHeight: pos.maxHeight,
            }}
            className={`fixed z-[100] rounded-xl border border-zinc-700 bg-zinc-800 shadow-2xl py-1 overflow-y-auto ${
              presence.phase === "exit"
                ? "mobile-popover-exit"
                : "mobile-popover-enter"
            }`}
          >
            {/* 默认（不传） */}
            <button
              type="button"
              role="option"
              aria-selected={!active}
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
              className={`
                w-full text-left px-3 py-2 transition-colors
                ${!active
                  ? "bg-indigo-600/20 border-l-2 border-indigo-500"
                  : "hover:bg-zinc-700 border-l-2 border-transparent"}
              `}
            >
              <div className="flex items-center justify-between gap-2">
                <span className={`text-sm truncate ${!active ? "text-indigo-300" : "text-zinc-200"}`}>
                  默认（不传）
                </span>
                {!active && <span className="text-xs text-indigo-400 flex-shrink-0">已选</span>}
              </div>
              <p className="text-xs text-zinc-400 mt-0.5">跟随模型自身默认，不注入 reasoning_effort</p>
            </button>

            {/* 模型声明的档位 */}
            {efforts.map((e) => {
              const selected = active && value === e;
              return (
                <button
                  key={e}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    onChange(e);
                    setOpen(false);
                  }}
                  className={`
                    w-full text-left px-3 py-2 transition-colors
                    ${selected
                      ? "bg-indigo-600/20 border-l-2 border-indigo-500"
                      : "hover:bg-zinc-700 border-l-2 border-transparent"}
                  `}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-sm truncate font-mono ${selected ? "text-indigo-300" : "text-zinc-200"}`}>
                      {e}
                    </span>
                    {selected && <span className="text-xs text-indigo-400 flex-shrink-0">已选</span>}
                  </div>
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
