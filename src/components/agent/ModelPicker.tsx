import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useSettingsStore } from '@/stores/settingsStore';
import { useAnimatedPresence } from '@/hooks/useAnimatedPresence';
import type { LlmRegistry } from '@/lib/types';
import {
  effectiveDefaultModel,
  modelLabel,
  modelPickerTriggerLabel,
} from '@/lib/llmRegistry';

/**
 * 输入框内的模型选择器（桌面端 / 移动端共用）。
 *
 * 展示当前会话生效的模型：会话级选择（conversation.modelId）优先，
 * 否则回落全局默认模型（设置页「默认模型」槽位）。点按弹出模型列表，
 * 选中即写入当前会话（经 setConversationModel 持久化 + 同步）。
 *
 * 弹窗使用与移动端模式切换一致的 mobile-popover 进出场动画（两端统一）；
 * 宽度受限 viewport 防止窄屏/键盘弹出时溢出。
 */
export function ModelPicker({
  value,
  onChange,
  disabled,
  compact = false,
}: {
  /** 当前会话的 modelId（null = 跟随全局默认）。 */
  value: string | null | undefined;
  onChange: (modelId: string | null) => void;
  disabled?: boolean;
  /** 紧凑模式（移动端/窄宽度时用）。 */
  compact?: boolean;
}) {
  const registry = useSettingsStore((s) => s.settings.llmRegistry);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  /** 弹窗本体 ref：portal 到 body 后用于点击外部关闭判断。 */
  const popoverRef = useRef<HTMLDivElement>(null);
  const presence = useAnimatedPresence(open);
  /** 弹窗 fixed 定位参数：打开时按触发按钮位置 + 视口钳制计算。 */
  const [pos, setPos] = useState<{
    bottom: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  const effectiveModel = value
    ? registry.models.find((m) => m.id === value)
    : effectiveDefaultModel(registry);
  // 输入框窄空间只显示模型名；仅当跨渠道有同名模型时才带「渠道名/」前缀消歧
  const triggerLabel = modelPickerTriggerLabel(registry, effectiveModel);
  const label = value
    ? (effectiveModel
        ? triggerLabel
        : '模型已失效（请重新选择）')
    : (effectiveDefaultModel(registry)
        ? `跟随默认 · ${triggerLabel}`
        : '未配置模型');
  // 紧凑模式（移动端）文字：与桌面同规则（重名消歧），替代原先的显示器图标
  const compactLabel = effectiveModel
    ? triggerLabel
    : value
      ? '已失效'
      : '未配置';

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      // 弹窗 portal 到 body，不在 containerRef 内：点击弹窗内部不关闭，
      // 点击按钮/弹窗之外才关闭。
      if (containerRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    };
    if (open) document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // 打开时测量触发按钮位置，把弹窗钳制在视口内：
  // - fixed 定位可避免被 agent 面板的 overflow-hidden 祖先裁剪（窄面板下
  //   弹窗右缘超出面板即被裁掉，导致「已选」等内容看不见）
  // - 弹窗底部锚定按钮顶部（bottom 语义），向上生长；左侧空间不足时
  //   自动右移（等效右对齐），宽度收缩到视口内
  // - useLayoutEffect 同步测量：打开首帧即定位，避免弹窗闪现
  // - 关闭时不清 pos：退出动画期间保留原位置播放
  useLayoutEffect(() => {
    if (!open) return;
    const btn = containerRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const MARGIN = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.max(160, Math.min(288, vw - MARGIN * 2));
    const left = Math.max(MARGIN, Math.min(rect.left, vw - MARGIN - width));
    // 弹窗底边 = 按钮顶边 - MARGIN（fixed bottom 相对视口底部）
    const bottom = vh - rect.top + MARGIN;
    // 按钮上方可用高度 = 按钮顶 - 视口顶 - MARGIN（保底 120px）
    const maxHeight = Math.max(120, rect.top - MARGIN * 2);
    setPos({ bottom, left, width, maxHeight });
  }, [open]);

  return (
    <div ref={containerRef} className="relative flex-shrink-0 self-center">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={`
          flex items-center gap-1 rounded-full text-xs font-medium transition-colors
          ${
            open
              ? "bg-zinc-700 text-zinc-100"
              : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50"
          }
          ${compact ? "px-1.5 py-1.5" : "px-2 py-1.5"}
          disabled:opacity-40 disabled:cursor-not-allowed
        `}
        title="切换本会话使用的模型（回车后生效）"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={`truncate ${compact ? "max-w-[5rem]" : "max-w-[9rem]"}`}>
          {compact ? compactLabel : label}
        </span>
        <svg
          className={`w-3 h-3 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
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
            role="listbox"
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
          {/* 跟随全局默认 */}
          <button
            type="button"
            role="option"
            aria-selected={!value}
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className={`
              w-full text-left px-3 py-2 transition-colors
              ${!value
                ? "bg-indigo-600/20 border-l-2 border-indigo-500"
                : "hover:bg-zinc-700 border-l-2 border-transparent"}
            `}
          >
            <div className="flex items-center justify-between">
              <span className={`text-sm ${!value ? "text-indigo-300" : "text-zinc-200"}`}>
                跟随全局默认
              </span>
              {!value && <span className="text-xs text-indigo-400">已选</span>}
            </div>
            <p className="text-xs text-zinc-400 mt-0.5">
              使用设置页「默认模型」槽位
            </p>
          </button>

          {/* 按提供商（渠道）分组的模型列表 */}
          {registry.channels.map((ch) => {
            const channelModels = registry.models.filter((m) => m.channelId === ch.id);
            if (channelModels.length === 0) return null;
            const channelDisabled = !ch.enabled;
            return (
              <div key={ch.id}>
                <div className="flex items-center gap-2 px-3 pt-2.5 pb-1">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500 truncate">
                    {ch.name}
                  </span>
                  {channelDisabled && (
                    <span className="text-[10px] px-1 py-0.5 rounded bg-zinc-700 text-zinc-400 flex-shrink-0">
                      已禁用
                    </span>
                  )}
                </div>
                {channelModels.map((m) => {
                  const active = value === m.id;
                  const disabled = channelDisabled;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="option"
                      aria-selected={active}
                      disabled={disabled}
                      onClick={() => {
                        onChange(m.id);
                        setOpen(false);
                      }}
                      className={`
                        w-full text-left px-3 py-2 transition-colors
                        ${active
                          ? "bg-indigo-600/20 border-l-2 border-indigo-500"
                          : "hover:bg-zinc-700 border-l-2 border-transparent"}
                        ${disabled ? "opacity-40 cursor-not-allowed" : ""}
                      `}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className={`text-sm truncate ${active ? "text-indigo-300" : "text-zinc-200"}`}>
                          {modelLabel(m)}
                        </span>
                        {active && <span className="text-xs text-indigo-400 flex-shrink-0">已选</span>}
                      </div>
                      <p className="text-xs text-zinc-400 mt-0.5 font-mono truncate">
                        {m.modelName}
                        {m.vision ? " · 视觉" : ""}
                      </p>
                    </button>
                  );
                })}
              </div>
            );
          })}
          {registry.channels.length === 0 && (
            <p className="px-3 py-4 text-center text-xs text-zinc-500">
              还没有可用模型，请先到「设置 → 模型服务」添加渠道与模型
            </p>
          )}
          </div>,
          document.body,
        )}
    </div>
  );
}

/** 从 registry 解析有效模型 id（会话级优先，否则全局默认）。 */
export function resolveEffectiveModelId(
  registry: LlmRegistry,
  conversationModelId: string | null | undefined,
): string | null {
  if (conversationModelId) {
    if (registry.models.some((m) => m.id === conversationModelId)) {
      return conversationModelId;
    }
    // 会话级模型已失效（被删除）→ 回落全局默认
    return effectiveDefaultModel(registry)?.id ?? null;
  }
  return effectiveDefaultModel(registry)?.id ?? null;
}
