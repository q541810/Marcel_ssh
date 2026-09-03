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
 * 触发按钮始终直接显示「本会话当前生效的模型」：会话曾切过模型 → 该会话
 * 记住上次选的（内存级）；从未切过的会话 → 自动跟随全局最后一次选择的
 * 模型。展示不带任何"跟随/默认/最近使用"前缀——它就是当前实际在用的模型。
 *
 * 弹窗只列真实模型（按渠道分组），点选 = 本会话固定用它 + 顺带更新全局
 * 最后一次选择。弹窗使用与移动端模式切换一致的进出场动画（两端统一）。
 */
export function ModelPicker({
  value,
  onChange,
  disabled,
  compact = false,
}: {
  /** 当前会话的 modelId（null/失效 = 自动跟随全局最后选择的模型）。 */
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

  // 当前生效模型：会话记忆有效用记忆；否则（无记忆/记忆失效）回落全局
  // 最后选择的模型（lastUsed → 首个）。直接显示模型名，不带任何前缀。
  const sessionModelValid = !!value && registry.models.some((m) => m.id === value);
  const effectiveModel = sessionModelValid
    ? registry.models.find((m) => m.id === value)
    : effectiveDefaultModel(registry);
  // 输入框窄空间只显示模型名；仅当跨渠道有同名模型时才带「渠道名/」前缀消歧
  const triggerLabel = modelPickerTriggerLabel(registry, effectiveModel);
  const label = effectiveModel ? triggerLabel : '未配置模型';
  // 紧凑模式（移动端）文字：与桌面同规则
  const compactLabel = effectiveModel ? triggerLabel : '未配置';

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
    // min-w-0 + 可收缩：工具栏空间不足时模型名随可用宽度截断让位，
    // 而不是把后面的按钮顶出输入框（空间充裕时仍按 max-w 上限完整展示）
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
        title={
          effectiveModel
            ? `${label} · 点击切换模型`
            : "未配置模型，请先到「设置 → 模型服务」添加"
        }
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={`truncate min-w-0 ${compact ? "max-w-[5rem]" : "max-w-[9rem]"}`}>
          {compact ? compactLabel : label}
        </span>
        <svg
          className={`w-3 h-3 flex-shrink-0 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
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
                  // 「已选」= 当前实际生效的模型（与触发按钮显示一致）：
                  // 会话手动切过的 → 勾会话记住的那个；从未手动切过（默认
                  // 跟随全局最近使用/首个）→ 勾自动落到的那个模型。勾选态
                  // 只表示"正在用它"，不代表会话有手动记忆。
                  const active = m.id === effectiveModel?.id;
                  const disabled = channelDisabled;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="option"
                      aria-selected={active}
                      disabled={disabled}
                      onClick={() => {
                        // 点当前已在生效的模型 = 与现状一致：会话若无手动
                        // 记忆则借此显式固定（内存级），行为不变
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

/**
 * 从 registry 解析有效模型 id（会话记忆优先，否则全局最后选择/首个）。
 * `conversationModelId` 失效（模型被删除）→ 回落全局最后选择。
 */
export function resolveEffectiveModelId(
  registry: LlmRegistry,
  conversationModelId: string | null | undefined,
): string | null {
  if (conversationModelId) {
    if (registry.models.some((m) => m.id === conversationModelId)) {
      return conversationModelId;
    }
    // 会话记忆指向的模型已失效（被删除）→ 回落全局最后选择
    return effectiveDefaultModel(registry)?.id ?? null;
  }
  return effectiveDefaultModel(registry)?.id ?? null;
}
