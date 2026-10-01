import { useState, useRef, useEffect, useLayoutEffect, useId } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { useAnimatedPresence } from '@/hooks/useAnimatedPresence';
import type { LlmRegistry } from '@/lib/types';
import { effectiveDefaultModel, modelLabel } from '@/lib/llmRegistry';
import './ReasoningEffortPicker.css';

const EFFORT_LABELS: Record<string, string> = {
  none: '关闭',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
  ultra: 'Ultra',
};
const SLIDER_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

function effortLabel(effort: string | null | undefined): string {
  if (effort == null) return '默认';
  return Object.prototype.hasOwnProperty.call(EFFORT_LABELS, effort) ? EFFORT_LABELS[effort] : effort;
}

/**
 * 桌面 / 移动端共用的紧凑分档滑条。
 * 仅展示模型声明的档位并保持其顺序；默认档传 null，跟随模型自身设置。
 * 拖动预览、松手保存，档位由父组件按「会话 × 模型」持久化。
 */
export function ReasoningEffortPicker({
  value,
  efforts,
  modelName,
  registry,
  modelId,
  onModelChange,
  onChange,
  disabled,
  compact = false,
}: {
  value: string | null | undefined;
  efforts: string[];
  modelName?: string;
  registry?: LlmRegistry;
  modelId?: string | null;
  onModelChange?: (modelId: string | null) => void;
  onChange: (effort: string | null) => void | Promise<void>;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const [isInteracting, setIsInteracting] = useState(false);
  const [ultraBurst, setUltraBurst] = useState(0);
  const [hoveredTick, setHoveredTick] = useState<number | null>(null);
  const [modelListOpen, setModelListOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const interactingRef = useRef(false);
  const draftRef = useRef<number | null>(null);
  const savingRef = useRef(false);
  const id = useId();
  const hasModelSettings = Boolean(registry && onModelChange);
  const isOpen = open && !disabled && (efforts.length > 0 || hasModelSettings);
  const presence = useAnimatedPresence(isOpen);
  const [pos, setPos] = useState<{
    top?: number;
    bottom?: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  const activeIndex = value ? efforts.indexOf(value) + 1 : 0;
  const index = previewIndex ?? activeIndex;
  const options = [null, ...efforts];
  const label = effortLabel(options[index]);
  const effectiveModel = registry
    ? (modelId && registry.models.some((model) => model.id === modelId)
      ? registry.models.find((model) => model.id === modelId)
      : effectiveDefaultModel(registry))
    : undefined;
  const resolvedModelName = modelName || modelLabel(effectiveModel) || '当前模型';
  // Treat the last available effort as the full-power state too. Some models
  // expose `max` as their final level without declaring an `ultra` option, but
  // the slider should still get the same completion animation there.
  const isUltra = options[index] === 'ultra' || index === efforts.length;
  const progress = efforts.length > 0 ? index / efforts.length : 0;
  const locked = disabled || saving || !isOpen;

  const cancelPreview = () => {
    interactingRef.current = false;
    draftRef.current = null;
    setIsInteracting(false);
    if (!savingRef.current) setPreviewIndex(null);
  };

  const commit = async (nextIndex: number) => {
    interactingRef.current = false;
    draftRef.current = null;
    setIsInteracting(false);
    if (locked || savingRef.current) return;
    if (nextIndex === activeIndex) {
      setPreviewIndex(null);
      return;
    }
    setPreviewIndex(nextIndex);
    setError(false);
    if (options[nextIndex] === 'ultra' || nextIndex === efforts.length) {
      setUltraBurst((current) => current + 1);
    }
    savingRef.current = true;
    setSaving(true);
    try {
      await onChange(options[nextIndex] ?? null);
    } catch {
      setError(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
      setPreviewIndex(null);
    }
  };

  useEffect(() => {
    if (!isOpen) {
      interactingRef.current = false;
      draftRef.current = null;
      setIsInteracting(false);
      setModelListOpen(false);
      if (!savingRef.current) setPreviewIndex(null);
      setOpen(false);
      return;
    }
    const close = () => {
      interactingRef.current = false;
      draftRef.current = null;
      if (!savingRef.current) setPreviewIndex(null);
      setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (containerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
      triggerRef.current?.focus();
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Node;
      if (containerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [isOpen]);

  // Portal 避免被输入框裁剪；空间不足时翻到按钮下方，并跟随软键盘/缩放后的可见视口。
  useLayoutEffect(() => {
    if (!isOpen) return;
    const viewport = window.visualViewport;
    const updatePosition = () => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const margin = 8;
      const viewportLeft = (viewport?.offsetLeft ?? 0) + margin;
      const viewportTop = (viewport?.offsetTop ?? 0) + margin;
      const viewportWidth = Math.max(0, (viewport?.width ?? window.innerWidth) - margin * 2);
      const viewportBottom = viewportTop + Math.max(0, (viewport?.height ?? window.innerHeight) - margin * 2);
      const width = Math.min(228, viewportWidth);
      const left = Math.max(viewportLeft, Math.min(rect.left, viewportLeft + viewportWidth - width));
      const above = Math.max(viewportTop, Math.min(rect.top - margin, viewportBottom));
      const below = Math.max(viewportTop, Math.min(rect.bottom + margin, viewportBottom));
      const spaceAbove = above - viewportTop;
      const spaceBelow = viewportBottom - below;
      const popover = popoverRef.current;
      const contentHeight = popover && popover.scrollHeight > 0
        ? popover.scrollHeight + popover.offsetHeight - popover.clientHeight
        : 96;
      const placeAbove = spaceAbove >= contentHeight || spaceAbove >= spaceBelow;
      setPos({
        left,
        width,
        maxHeight: placeAbove ? spaceAbove : spaceBelow,
        ...(placeAbove ? { bottom: window.innerHeight - above } : { top: below }),
      });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    viewport?.addEventListener('resize', updatePosition);
    viewport?.addEventListener('scroll', updatePosition);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      viewport?.removeEventListener('resize', updatePosition);
      viewport?.removeEventListener('scroll', updatePosition);
    };
  }, [isOpen, presence.mounted, efforts, error, saving]);

  useEffect(() => {
    if (isOpen && presence.mounted && pos && !saving) sliderRef.current?.focus({ preventScroll: true });
  }, [isOpen, presence.mounted, pos, saving]);

  if (efforts.length === 0 && !hasModelSettings) return null;

  return (
    <div ref={containerRef} className="relative min-w-0 self-center">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => {
          cancelPreview();
          setOpen((previous) => {
            const next = !previous;
            // A model without declared reasoning efforts uses this same entry
            // point for model selection, so opening goes straight to the list.
            setModelListOpen(next && efforts.length === 0 && hasModelSettings);
            return next;
          });
        }}
        className={`flex w-full min-w-0 items-center gap-1 rounded-full text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 ${
          isOpen ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50'
        } ${compact ? 'px-1.5 py-1.5' : 'px-2 py-1.5'} disabled:opacity-40 disabled:cursor-not-allowed`}
        title={hasModelSettings ? `模型设置：${resolvedModelName}` : `思考强度：${label}`}
        aria-label={hasModelSettings ? `模型设置：${resolvedModelName}` : `思考强度：${label}`}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? id : undefined}
      >
        <SlidersHorizontal size={13} className="shrink-0" aria-hidden="true" />
        <span className="min-w-0 max-w-[8rem] truncate">{hasModelSettings ? resolvedModelName : label}</span>
        <ChevronDown size={12} className="shrink-0" aria-hidden="true" />
      </button>

      {presence.mounted && pos && createPortal(
        <div
          ref={popoverRef}
          id={id}
          role="dialog"
          aria-label="思考强度"
          aria-hidden={!isOpen}
          aria-busy={saving}
          onAnimationEnd={presence.onAnimationEnd}
          style={pos}
          className={`reasoning-effort-popover fixed z-[100] overflow-y-auto ${isUltra ? 'reasoning-effort-ultra' : ''} ${
            presence.phase === 'exit' ? 'mobile-popover-exit pointer-events-none' : 'mobile-popover-enter'
          }`}
        >
          <div className="reasoning-effort-heading">
            {!modelListOpen && <h3 className="reasoning-effort-value" title={label}>{label}</h3>}
            {!modelListOpen && <button
              type="button"
              id={`${id}-model`}
              className="reasoning-effort-model"
              title={hasModelSettings ? '点击选择模型' : resolvedModelName}
              disabled={!hasModelSettings || saving}
              aria-haspopup={hasModelSettings ? 'listbox' : undefined}
              aria-expanded={hasModelSettings ? modelListOpen : undefined}
              onClick={() => setModelListOpen((current) => !current)}
            >
              <span>{resolvedModelName}</span>
              <ChevronRight size={10} aria-hidden="true" />
            </button>}
          </div>
          {!modelListOpen && <button
            type="button"
            onClick={() => void commit(0)}
            disabled={locked || index === 0}
            tabIndex={isOpen ? 0 : -1}
            className="reasoning-effort-reset"
            title="恢复默认思考强度"
            aria-label="恢复默认思考强度"
          >
            <RotateCcw size={16} aria-hidden="true" />
          </button>}
          {modelListOpen && registry && onModelChange ? (
            <div className="reasoning-effort-model-list" role="listbox" aria-label="选择模型">
              {registry.channels.map((channel) => {
                const models = registry.models.filter((model) => model.channelId === channel.id);
                if (models.length === 0) return null;
                return (
                  <div key={channel.id}>
                    <div className="reasoning-effort-model-channel">{channel.name}</div>
                    {models.map((model) => {
                      const active = model.id === effectiveModel?.id;
                      return (
                        <button
                          key={model.id}
                          type="button"
                          role="option"
                          aria-selected={active}
                          disabled={!channel.enabled || saving}
                          className={`reasoning-effort-model-option${active ? ' is-active' : ''}`}
                          onClick={() => {
                            onModelChange(model.id);
                            setModelListOpen(false);
                          }}
                        >
                          <span>{modelLabel(model)}</span>
                          {active && <span aria-hidden="true">✓</span>}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
              {registry.models.length === 0 && <p className="reasoning-effort-model-empty">还没有可用模型</p>}
            </div>
          ) : efforts.length === 0 ? (
            <p className="reasoning-effort-model-empty">当前模型未配置思考强度</p>
          ) : (
          <>
          <p id={`${id}-description`} className="sr-only">
            {index === 0 ? '跟随模型默认设置。' : '更高强度适合复杂任务，可能需要更多时间。'}
          </p>
          <div className={`reasoning-effort-control${isInteracting ? ' is-interacting' : ''}`}>
            <div className="reasoning-effort-track" aria-hidden="true">
              <div
                className="reasoning-effort-fill"
                style={{ width: index === efforts.length ? '100%' : `calc(${progress * 100}% + ${14 - progress * 28}px)` }}
              />
              {isUltra && <span className="reasoning-effort-stars" />}
              {isUltra && ultraBurst > 0 && (
                <span
                  key={ultraBurst}
                  className="reasoning-effort-ultra-particles"
                  aria-hidden="true"
                  style={{ left: `calc(${progress * 100}% + ${14 - progress * 28}px)` }}
                />
              )}
              <div className="reasoning-effort-ticks">
                {options.map((_, step) => (
                  <span
                    key={step}
                    className={hoveredTick === step ? 'is-hovered' : undefined}
                    style={{ left: `${step / efforts.length * 100}%` }}
                  />
                ))}
              </div>
            </div>
            <span
              className="reasoning-effort-thumb"
              aria-hidden="true"
              style={{ left: `calc(${progress * 100}% + ${14 - progress * 28}px)` }}
            />
            <input
              ref={sliderRef}
              type="range"
              min={0}
              max={efforts.length}
              step={1}
              value={index}
              disabled={locked}
              tabIndex={isOpen ? 0 : -1}
              aria-label="思考强度"
              aria-valuetext={label}
              aria-describedby={`${id}-model ${id}-description`}
              className="reasoning-effort-slider"
              onPointerDown={(event) => {
                interactingRef.current = true;
                setIsInteracting(true);
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (efforts.length === 0) return;
                const rect = event.currentTarget.getBoundingClientRect();
                const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
                setHoveredTick(Math.round(ratio * efforts.length));
              }}
              onPointerLeave={() => setHoveredTick(null)}
              onChange={(event) => {
                const nextIndex = event.currentTarget.valueAsNumber;
                if (interactingRef.current) {
                  draftRef.current = nextIndex;
                  setPreviewIndex(nextIndex);
                } else {
                  void commit(nextIndex);
                }
              }}
              onPointerUp={(event) => void commit(event.currentTarget.valueAsNumber)}
              onPointerCancel={cancelPreview}
              onKeyDown={(event) => {
                if (SLIDER_KEYS.has(event.key)) {
                  interactingRef.current = true;
                  setIsInteracting(true);
                }
              }}
              onKeyUp={(event) => {
                if (SLIDER_KEYS.has(event.key)) void commit(event.currentTarget.valueAsNumber);
              }}
              onBlur={() => {
                if (draftRef.current != null) void commit(draftRef.current);
              }}
            />
          </div>
          </>
          )}
          {error && <p role="alert" className="reasoning-effort-status reasoning-effort-error">未能保存，请重试。</p>}
        </div>,
        document.body,
      )}
    </div>
  );
}
