import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Check as LucideCheck } from 'lucide-react';
import { useThemeSynced } from "@/hooks/useThemeSynced";
import SweepTransition from "@/components/ui/SweepTransition";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import type { TerminalColors } from "@/lib/types";
import { DEFAULT_TERMINAL_COLORS } from "@/lib/constants";
import { resolveTerminalColors } from "@/lib/terminalTheme";
import {
  BUNDLED_FONT_STACK,
  SYSTEM_MONO_FONT_STACK,
  detectInstalledMonoFonts,
  primaryFontFamily,
  resolveEffectiveFont,
  stackForPickedFont,
} from "@/lib/fontAvailability";
import {
  buildTerminalFontFamily,
  isBundledNerdFontFamily,
} from "@/lib/terminalFont";

const BUNDLED_KEY = "__bundled";
const SYSTEM_KEY = "__system";
const CUSTOM_KEY = "__custom";
const FONT_KEY_PREFIX = "font:";

/** 每行拿自己的字体渲染这一句：窄字符、易混淆字符、符号、汉字都在里面，差异一眼可见。 */
const ROW_SAMPLE = "ls -la ~/ → 0O1lI { } 你好";

interface Props {
  /** 当前字体栈（设置里的 fontFamily，已含 preview 覆盖）。 */
  value: string;
  onChange: (stack: string) => void;
  /** 预览用字号与配色，跟终端设置走，预览才和真实终端一致。 */
  fontSize: number;
  terminalColors?: TerminalColors | null;
  /**
   * mobile：只给「内置 / 系统等宽」两张卡片，不提供自定义输入——安卓装不了自定义字体，
   * 手打字体名没有意义。desktop：弹出列表里额外有本机已安装字体、搜索与自定义字体栈。
   */
  variant: "desktop" | "mobile";
}

interface FontItem {
  key: string;
  /** 界面上显示的名字（用界面字体渲染）。 */
  label: string;
  /** 下发给终端的字体栈；用它渲染这一行的样本。 */
  stack: string;
  hint?: string;
}

/** 当前字体栈对应哪一项。 */
function selectedKey(value: string, installed: readonly string[]): string {
  const primary = primaryFontFamily(value);
  if (isBundledNerdFontFamily(primary)) return BUNDLED_KEY;
  if (primary.toLowerCase() === SYSTEM_MONO_FONT_STACK) return SYSTEM_KEY;
  if (installed.includes(primary)) return FONT_KEY_PREFIX + primary;
  return CUSTOM_KEY;
}

function Check() {
  return (
    <LucideCheck size={14} strokeWidth={1.5} aria-hidden />
  );
}

/** 一行字体：上面是名字（界面字体），下面是用该字体渲染的样本。 */
function FontRow({
  item,
  selected,
  active,
  onPick,
  onHover,
  roomy,
}: {
  item: FontItem;
  selected: boolean;
  active: boolean;
  onPick: () => void;
  onHover?: () => void;
  roomy?: boolean;
}) {
  return (
    <div
      data-opt
      role="option"
      aria-selected={selected}
      onPointerDown={(e) => {
        e.preventDefault();
        onPick();
      }}
      onPointerEnter={onHover}
      className={`flex cursor-pointer items-center gap-3 rounded-lg px-3 transition-colors duration-100 ${
        roomy ? "py-3" : "py-2"
      } ${active ? "bg-state-mid" : ""} ${selected ? "text-indigo-400" : "text-fg"}`}
    >
      <div className="min-w-0 flex-1">
        <div
          className={`flex items-center gap-2 text-caption leading-tight ${
            selected ? "text-indigo-400" : "text-fg-tertiary"
          }`}
        >
          <span className="truncate">{item.label}</span>
          {item.hint && (
            <span className="flex-shrink-0 rounded bg-state-soft px-1 py-px text-caption text-fg-secondary">
              {item.hint}
            </span>
          )}
        </div>
        <div
          className="mt-1 truncate whitespace-pre text-read leading-snug"
          style={{ fontFamily: buildTerminalFontFamily(item.stack) }}
        >
          {ROW_SAMPLE}
        </div>
      </div>
      <span className={`w-4 flex-shrink-0 ${selected ? "text-indigo-400" : "text-transparent"}`}>
        <Check />
      </span>
    </div>
  );
}

/** 用终端自己的配色与字号渲染的预览：所见即所得，配色/字号变了它也跟着变。 */
function TerminalPreview({
  stack,
  fontSize,
  colors,
}: {
  stack: string;
  fontSize: number;
  colors?: TerminalColors | null;
}) {
  // 终端配色来自状态而非 CSS 变量，不扣住的话切主题时它会在圆形揭开之前就变色
  const syncedColors = useThemeSynced(colors);
  const theme = resolveTerminalColors(syncedColors ?? DEFAULT_TERMINAL_COLORS);
  // 换字体时由 SweepTransition 做「新字体自左向右扫过旧字体」；配色 / 字号变化不走扫光
  return (
    <SweepTransition
      value={stack}
      ariaLabel="字体预览"
      className="rounded-xl border border-edge-subtle px-4 py-3 shadow-inner"
      style={{
        background: theme.background,
        color: theme.foreground,
        fontSize,
        lineHeight: 1.5,
      }}
      render={(s) => (
        <div style={{ fontFamily: buildTerminalFontFamily(s) }}>
          <div className="truncate whitespace-pre">
            <span style={{ color: theme.green }}>marcel@server</span>
            <span>:</span>
            <span style={{ color: theme.blue }}>~</span>
            <span>$ ls -la ~/ → ✓</span>
          </div>
          <div className="truncate whitespace-pre" style={{ color: theme.brightBlack ?? theme.foreground }}>
            {"        "}
            <span style={{ color: theme.magenta }}>main</span> ✔
          </div>
          <div className="truncate whitespace-pre">0O1lI  {"{ } [ ] => != "} 你好世界</div>
        </div>
      )}
    />
  );
}

/**
 * 终端字体选择器（桌面设置页与手机外观页共用）。
 *
 * - 预览在最上面，选择器在它下面：弹出的列表向下展开，不会盖住预览；选定后预览用
 *   SweepTransition 自左向右扫过，把「字体变成了什么样」演出来。
 * - 桌面：点开弹出列表，每行用自己的字体渲染一句样本；点选才生效。
 * - 手机：两张卡片直接点选，不弹层。
 * - 自定义字体栈只在回车 / 失去焦点时提交，不再每敲一个字符就让终端重排一次。
 */
export function FontFamilyPicker({
  value,
  onChange,
  fontSize,
  terminalColors,
  variant,
}: Props) {
  const desktop = variant === "desktop";
  const installed = useMemo(
    () => (desktop ? detectInstalledMonoFonts() : []),
    [desktop],
  );
  const key = selectedKey(value, installed);
  const effective = useMemo(() => resolveEffectiveFont(value), [value]);

  const [open, setOpen] = useState(false);
  const presence = useAnimatedPresence(open);
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [draft, setDraft] = useState(value);

  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  /** 只有键盘导航 / 刚打开才滚动到高亮项；鼠标悬停改高亮不该滚动列表。 */
  const scrollToActive = useRef(false);

  useEffect(() => setDraft(value), [value]);

  const items = useMemo<FontItem[]>(() => {
    const list: FontItem[] = [
      {
        key: BUNDLED_KEY,
        label: "Marcel Nerd Font Mono",
        stack: BUNDLED_FONT_STACK,
        hint: "内置 · 含图标",
      },
      {
        key: SYSTEM_KEY,
        label: "系统等宽",
        stack: SYSTEM_MONO_FONT_STACK,
        hint: "跟随设备",
      },
    ];
    for (const name of installed) {
      list.push({
        key: FONT_KEY_PREFIX + name,
        label: name,
        stack: stackForPickedFont(name),
      });
    }
    // 手机上旧存档可能留着别的字体栈：如实显示成当前项，别让界面凭空显示成「内置」
    if (!desktop && key === CUSTOM_KEY) {
      list.push({
        key: CUSTOM_KEY,
        label: primaryFontFamily(value) || "未设置",
        stack: value,
        hint: "当前",
      });
    }
    return list;
  }, [desktop, installed, key, value]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((i) => i.label.toLowerCase().includes(q)) : items;
  }, [items, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveKey(key);
    scrollToActive.current = true;
    // 只在「打开」那一刻定位高亮；之后 key 变化（选中）会随即关闭
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 面板由 useAnimatedPresence 在打开后的下一次渲染才挂载，搜索框要等它出现再聚焦
  useEffect(() => {
    if (open && presence.mounted) searchRef.current?.focus({ preventScroll: true });
  }, [open, presence.mounted]);

  useEffect(() => {
    if (!open || !scrollToActive.current || !activeKey || !listRef.current) return;
    const idx = visible.findIndex((i) => i.key === activeKey);
    const el = listRef.current.querySelectorAll("[data-opt]")[idx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
    scrollToActive.current = false;
  }, [open, activeKey, visible]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const pick = (item: FontItem) => {
    setCustomOpen(false);
    setOpen(false);
    if (item.key === BUNDLED_KEY) onChange(BUNDLED_FONT_STACK);
    else if (item.key === SYSTEM_KEY) onChange(SYSTEM_MONO_FONT_STACK);
    else if (item.key.startsWith(FONT_KEY_PREFIX)) onChange(item.stack);
    // CUSTOM_KEY（手机上的「当前」卡片）选中等于保持不变
  };

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const cur = visible.findIndex((i) => i.key === activeKey);
      const next = Math.max(
        0,
        Math.min(visible.length - 1, cur + (e.key === "ArrowDown" ? 1 : -1)),
      );
      if (visible[next]) {
        scrollToActive.current = true;
        setActiveKey(visible[next].key);
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = visible.find((i) => i.key === activeKey) ?? visible[0];
      if (item) pick(item);
    }
  };

  const commitDraft = () => {
    const next = draft.trim();
    if (!next) {
      setDraft(value);
      return;
    }
    if (next !== value) onChange(next);
  };

  const showCustom = desktop && (customOpen || key === CUSTOM_KEY);
  const actualLabel =
    effective.name === "monospace"
      ? "系统等宽"
      : isBundledNerdFontFamily(effective.name)
        ? "内置 Nerd Font"
        : effective.name;

  const hint =
    effective.missing.length > 0 ? (
      <p className="text-meta leading-relaxed text-amber-400">
        这台设备上没找到「{effective.missing.join("、")}」，当前实际使用：{actualLabel}
      </p>
    ) : showCustom ? (
      <p className="text-meta leading-relaxed text-fg-tertiary">
        当前实际使用：{actualLabel}。多个字体用逗号隔开，靠前的优先；回车或点别处生效
      </p>
    ) : null;

  // ---- 手机：卡片直接点选 ----
  if (!desktop) {
    return (
      <div className="mt-2 flex flex-col gap-3">
        <TerminalPreview stack={value} fontSize={fontSize} colors={terminalColors} />
        <div role="listbox" className="flex flex-col gap-1 rounded-xl border border-edge-subtle bg-surface-sunken p-1">
          {items.map((item) => (
            <FontRow
              key={item.key}
              item={item}
              selected={item.key === key}
              active={false}
              onPick={() => pick(item)}
              roomy
            />
          ))}
        </div>
        {hint}
      </div>
    );
  }

  // ---- 桌面：触发按钮 + 弹出列表 ----
  const current = items.find((i) => i.key === key);
  return (
    <div className="flex w-full max-w-md flex-col gap-3">
      <TerminalPreview stack={value} fontSize={fontSize} colors={terminalColors} />
      <div ref={containerRef} className="relative">
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={`flex w-full items-center gap-2 rounded-xl border bg-surface-raised px-4 py-2 text-left transition-[border-color,transform] duration-100 focus:outline-none ${
            open ? "border-indigo-500" : "border-edge hover:border-edge-strong focus-visible:border-indigo-500"
          }`}
        >
          <span
            className="flex-1 truncate text-read text-fg"
            style={{ fontFamily: buildTerminalFontFamily(value) }}
          >
            {current?.label ?? (primaryFontFamily(value) || "未设置")}
          </span>
          {key === CUSTOM_KEY && (
            <span className="flex-shrink-0 rounded bg-state-soft px-2 py-px text-caption text-fg-secondary">
              自定义
            </span>
          )}
          <ChevronDown size={16} strokeWidth={1.5} className={`flex-shrink-0 text-fg-tertiary transition-transform duration-200 ${open ? "rotate-180" : ""}`} aria-hidden />
        </button>

        {presence.mounted && (
          <div
            onKeyDown={onListKeyDown}
            onAnimationEnd={presence.onAnimationEnd}
            className={`absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-xl border border-edge bg-surface-raised shadow-raised ${
              presence.phase === "exit" ? "dropdown-exit pointer-events-none" : "dropdown-enter"
            }`}
          >
            <div className="border-b border-edge-subtle p-2">
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  const first = items.find((i) =>
                    i.label.toLowerCase().includes(e.target.value.trim().toLowerCase()),
                  );
                  setActiveKey(first?.key ?? null);
                }}
                placeholder="搜索字体"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="w-full rounded-lg bg-surface/60 px-3 py-2 text-body text-fg placeholder:text-fg-tertiary focus-ring"
              />
            </div>
            <div ref={listRef} role="listbox" className="max-h-80 overflow-auto p-1 !animate-none">
              {visible.map((item) => (
                <FontRow
                  key={item.key}
                  item={item}
                  selected={item.key === key}
                  active={item.key === activeKey}
                  onPick={() => pick(item)}
                  onHover={() => {
                    scrollToActive.current = false;
                    setActiveKey(item.key);
                  }}
                />
              ))}
              {visible.length === 0 && (
                <div className="px-3 py-4 text-center text-meta text-fg-tertiary">
                  没有匹配的已安装字体，可在下方选「自定义字体栈」手输
                </div>
              )}
            </div>
            <div className="border-t border-edge-subtle p-1">
              <div
                role="option"
                aria-selected={key === CUSTOM_KEY}
                onPointerDown={(e) => {
                  e.preventDefault();
                  setOpen(false);
                  setCustomOpen(true);
                }}
                className="cursor-pointer rounded-lg px-3 py-2 text-body text-fg-secondary transition-colors duration-100 hover:bg-state-mid"
              >
                自定义字体栈…
              </div>
            </div>
          </div>
        )}
      </div>

      {showCustom && (
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setDraft(value);
              e.currentTarget.blur();
            }
          }}
          placeholder='例如 "Sarasa Mono SC", monospace'
          autoFocus={customOpen && key !== CUSTOM_KEY}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label="自定义字体栈"
          className="w-full rounded-xl border border-edge bg-surface-raised px-4 py-2 font-mono text-body text-fg outline-none transition-colors focus:border-indigo-500"
        />
      )}

      {hint}
    </div>
  );
}

