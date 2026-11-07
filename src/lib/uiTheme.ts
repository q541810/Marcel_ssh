import { DEFAULT_TERMINAL_COLORS, TERMINAL_COLOR_PRESETS } from "./constants";
import type {
  TerminalColors,
  UiThemeSettings,
  UiThemeZoneId,
  UiThemeZones,
} from "./types";

/*
 * 应用主题（UI theme）唯一来源。
 *
 * 模型：定一组「颜色分区」（中性灰阶槽位 + 语义色槽位），每个槽位一个颜色，
 * 槽位映射到 Tailwind v4 的调色板 CSS 变量（--color-zinc-* / --color-indigo-* …）。
 * 全 app 的 zinc/indigo/red/amber/emerald/sky 工具类都解析到这些变量，所以在
 * <html> 上写一遍变量，桌面与移动端、所有已挂载面板立即整体换色，无需逐组件改。
 *
 * 语义色只保存一个「基准色」（用户在取色器里挑的那个，对应色阶 500 档），
 * 完整 11 档色阶由 deriveScale 按 OKLCH 从参考色阶曲线推导。
 * 中性灰阶是 10 个独立槽位（zinc-950…zinc-100），所见即所得，配合
 * deriveNeutralRamp 可以按「背景/卡片/标题」三档自动铺满。
 *
 * 消费方：useUiTheme（双端 App 根挂载）、UiThemeEditor（设置页编辑器，双端共用）。
 */

export type UiThemeNeutralSection = "fill" | "state" | "edge" | "text";

export interface UiThemeZoneDef {
  id: UiThemeZoneId;
  /** 中性槽位直接映射的 CSS 变量；语义槽位为空（走整条色阶推导）。 */
  cssVar?: string;
  label: string;
  hint: string;
  /** 语义槽位：推导整条色阶时写入的 Tailwind 调色板名。 */
  palette?: string;
  group: "neutral" | "semantic";
  /** 中性槽位在编辑器里的分组（填充 / 状态 / 边框 / 文字）。 */
  section?: UiThemeNeutralSection;
}

export const UI_THEME_NEUTRAL_SECTIONS: {
  id: UiThemeNeutralSection;
  label: string;
  hint: string;
}[] = [
  { id: "fill", label: "填充", hint: "背景与卡片的底色" },
  { id: "state", label: "悬停与按下", hint: "鼠标悬停、按下时的底色" },
  { id: "edge", label: "边框", hint: "分隔线与控件描边" },
  { id: "text", label: "文字", hint: "从弱到强的文字色" },
];

/*
 * 中性槽位按「用途」而不是按色阶档位拆：Tailwind 里 bg-/border-/hover:bg- 读的是同一个
 * --color-zinc-N，按档位只有一个旋钮就会「调卡片灰、连分隔线和悬停一起变」。
 * 填充槽位仍映射 zinc 变量（bg-zinc-N / text-zinc-600 等沿用）；
 * 状态与边框槽位映射独立的 --color-state-* / --color-edge-*（globals.css @theme 声明，
 * 源码里 border-zinc-* 与 hover:bg-zinc-* 已全部迁到这些类名）。
 */
export const UI_THEME_NEUTRAL_ZONES: UiThemeZoneDef[] = [
  {
    id: "bg",
    cssVar: "--color-zinc-950",
    label: "外框",
    hint: "顶栏、导航栏与手机页底",
    group: "neutral",
    section: "fill",
  },
  {
    id: "surface",
    cssVar: "--color-zinc-900",
    label: "画布",
    hint: "桌面主区域、侧栏与对话区的底色",
    group: "neutral",
    section: "fill",
  },
  {
    id: "card",
    cssVar: "--color-zinc-800",
    label: "卡片",
    hint: "卡片、输入框、列表项的底色",
    group: "neutral",
    section: "fill",
  },
  {
    id: "control",
    cssVar: "--color-zinc-700",
    label: "控件",
    hint: "按钮、开关轨道、标签的底色",
    group: "neutral",
    section: "fill",
  },
  {
    id: "controlStrong",
    cssVar: "--color-zinc-600",
    label: "强控件",
    hint: "更醒目的控件底与滚动条",
    group: "neutral",
    section: "fill",
  },
  {
    id: "hoverSoft",
    cssVar: "--color-state-soft",
    label: "悬停·轻",
    hint: "列表行与透明按钮的悬停、按下",
    group: "neutral",
    section: "state",
  },
  {
    id: "hoverMid",
    cssVar: "--color-state-mid",
    label: "悬停·中",
    hint: "按钮与卡片内的悬停、按下",
    group: "neutral",
    section: "state",
  },
  {
    id: "hoverStrong",
    cssVar: "--color-state-strong",
    label: "悬停·重",
    hint: "次级按钮的悬停",
    group: "neutral",
    section: "state",
  },
  {
    id: "selected",
    cssVar: "--color-state-selected",
    label: "选中",
    hint: "侧栏、标签栏、历史列表里当前选中项的底",
    group: "neutral",
    section: "state",
  },
  {
    id: "edgeSubtle",
    cssVar: "--color-edge-subtle",
    label: "分隔线",
    hint: "面板之间、区块之间的淡分隔线",
    group: "neutral",
    section: "edge",
  },
  {
    id: "edge",
    cssVar: "--color-edge",
    label: "边框",
    hint: "输入框、卡片、按钮的描边",
    group: "neutral",
    section: "edge",
  },
  {
    id: "edgeStrong",
    cssVar: "--color-edge-strong",
    label: "强边框",
    hint: "更醒目的描边与聚焦前的边框",
    group: "neutral",
    section: "edge",
  },
  {
    id: "textMuted",
    cssVar: "--color-zinc-500",
    label: "弱文字",
    hint: "占位符与最弱的说明文字",
    group: "neutral",
    section: "text",
  },
  {
    id: "textSecondary",
    cssVar: "--color-zinc-400",
    label: "次要文字",
    hint: "说明文字与图标",
    group: "neutral",
    section: "text",
  },
  {
    id: "textBright",
    cssVar: "--color-zinc-300",
    label: "次要文字·亮",
    hint: "较亮的说明文字",
    group: "neutral",
    section: "text",
  },
  {
    id: "textBody",
    cssVar: "--color-zinc-200",
    label: "正文",
    hint: "消息与表单的正文颜色",
    group: "neutral",
    section: "text",
  },
  {
    id: "textHeading",
    cssVar: "--color-zinc-100",
    label: "标题",
    hint: "标题与强调文字",
    group: "neutral",
    section: "text",
  },
];

/** 语义槽位：每个槽位推导整条 11 档色阶并写入对应调色板变量。 */
export const UI_THEME_SEMANTIC_ZONES: UiThemeZoneDef[] = [
  {
    id: "accent",
    label: "主色",
    hint: "按钮、选中态、链接的强调色",
    palette: "indigo",
    group: "semantic",
  },
  {
    id: "danger",
    label: "危险",
    hint: "错误、删除、断开连接",
    palette: "red",
    group: "semantic",
  },
  {
    id: "warning",
    label: "警告",
    hint: "警示与待注意状态",
    palette: "amber",
    group: "semantic",
  },
  {
    id: "success",
    label: "成功",
    hint: "成功与在线状态",
    palette: "emerald",
    group: "semantic",
  },
  {
    id: "info",
    label: "信息",
    hint: "信息提示与次要强调",
    palette: "sky",
    group: "semantic",
  },
];

export const UI_THEME_ALL_ZONES: UiThemeZoneDef[] = [
  ...UI_THEME_NEUTRAL_ZONES,
  ...UI_THEME_SEMANTIC_ZONES,
];

/** Tailwind 默认 zinc（hex 近似），即「曜石」预设。默认主题必须与不启用主题时逐像素一致。 */
const DEFAULT_NEUTRAL = {
  bg: "#09090b",
  surface: "#18181b",
  card: "#27272a",
  control: "#3f3f46",
  controlStrong: "#52525b",
  hoverSoft: "#27272a",
  hoverMid: "#3f3f46",
  hoverStrong: "#52525b",
  selected: "#27272a",
  edgeSubtle: "#27272a",
  edge: "#3f3f46",
  edgeStrong: "#52525b",
  textMuted: "#71717a",
  textSecondary: "#a1a1aa",
  textBright: "#d4d4d8",
  textBody: "#e4e4e7",
  textHeading: "#f4f4f5",
};

const DEFAULT_SEMANTIC: Record<
  "accent" | "danger" | "warning" | "success" | "info",
  string
> = {
  accent: "#6c78e6",
  danger: "#ef4444",
  warning: "#f59e0b",
  success: "#10b981",
  info: "#0ea5e9",
};

export const DEFAULT_UI_THEME_ZONES: UiThemeZones = {
  ...DEFAULT_NEUTRAL,
  ...DEFAULT_SEMANTIC,
};

export interface UiThemePreset {
  id: string;
  name: string;
  /** 明暗归属：驱动 color-scheme 与 data-marcel-theme。 */
  scheme: "dark" | "light";
  zones: UiThemeZones;
  /** 随预设成套的终端配色：选预设时 terminalColors 一并写入，终端与界面永远是一套。 */
  terminal: TerminalColors;
}

function terminalPreset(name: string): TerminalColors {
  return (
    TERMINAL_COLOR_PRESETS.find((p) => p.name === name)?.colors ??
    DEFAULT_TERMINAL_COLORS
  );
}

export const CUSTOM_PRESET_ID = "custom";
const DEFAULT_PRESET_ID = "obsidian";

function zones(partial: Partial<UiThemeZones>): UiThemeZones {
  return { ...DEFAULT_UI_THEME_ZONES, ...partial };
}

export const UI_THEME_PRESETS: UiThemePreset[] = [
  {
    id: "obsidian",
    name: "曜石",
    scheme: "dark",
    zones: zones(DEFAULT_NEUTRAL),
    terminal: DEFAULT_TERMINAL_COLORS,
  },
  {
    id: "daylight",
    name: "晨雾",
    scheme: "light",
    zones: zones({
      // 浅色不能照搬暗色的层级：暗色里「越高越亮」（chrome 950 < 画布 900 < 卡片 800），
      // 平移到浅色就成了一整片灰蓝（前两版晨雾丑的根因）。浅色的正确层级是反过来的——
      // 画布（surface，桌面主区域/侧栏/对话区）是纯白，外框（bg：顶栏、导航栏、手机页底）
      // 与卡片/输入框是同一档极淡的暖中性灰，边框与悬停再深一小步。
      // 手机上页底（950）灰、分组卡片（900）白，天然就是 iOS 的分组样式。
      bg: "#f3f3f6",
      surface: "#ffffff",
      card: "#f1f1f5",
      control: "#e5e5ea",
      controlStrong: "#d1d1d9",
      hoverSoft: "#efeff3",
      hoverMid: "#e5e5ea",
      hoverStrong: "#d9d9e0",
      // 选中项要压过外框灰（bg/card）一档才看得出，比悬停再深一点
      selected: "#dfdfe8",
      edgeSubtle: "#ebebf0",
      edge: "#dedee5",
      edgeStrong: "#cdcdd6",
      textMuted: "#8a8a94",
      textSecondary: "#62626c",
      textBright: "#46464f",
      textBody: "#26262c",
      textHeading: "#111114",
      // 语义基准色都取色阶里较深的一档：浅色下白底要压得住，文字档靠镜像曲线自动变深
      accent: "#5558e3",
      danger: "#dc2626",
      warning: "#b45309",
      success: "#059669",
      info: "#0284c7",
    }),
    terminal: terminalPreset("亮色"),
  },
  {
    id: "graphite",
    name: "石墨",
    scheme: "dark",
    zones: zones({
      bg: "#000000",
      surface: "#0d0d0d",
      card: "#1a1a1a",
      control: "#2a2a2a",
      controlStrong: "#404040",
      hoverSoft: "#1a1a1a",
      hoverMid: "#2a2a2a",
      hoverStrong: "#404040",
      selected: "#1a1a1a",
      edgeSubtle: "#1a1a1a",
      edge: "#2a2a2a",
      edgeStrong: "#404040",
      textMuted: "#808080",
      textSecondary: "#ababab",
      textBright: "#d0d0d0",
      textBody: "#e8e8e8",
      textHeading: "#ffffff",
      accent: "#8b9cff",
      danger: "#ff6b6b",
      warning: "#ffc53d",
      success: "#3ddc97",
      info: "#4dc3ff",
    }),
    terminal: {
      ...terminalPreset("暗色"),
      background: "#000000",
      foreground: "#e8e8e8",
      cursorAccent: "#000000",
      selectionBackground: "#8b9cff",
    },
  },
];

export function getUiThemePreset(id: string): UiThemePreset | undefined {
  return UI_THEME_PRESETS.find((p) => p.id === id);
}

export const DEFAULT_UI_THEME_SETTINGS: UiThemeSettings = {
  presetId: DEFAULT_PRESET_ID,
  zones: DEFAULT_UI_THEME_ZONES,
};

/* ── OKLCH 色彩数学（无依赖，仅服务色阶推导） ── */

interface Oklch {
  l: number;
  c: number;
  h: number;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (m) {
    const n = parseInt(m[1], 16);
    return [
      ((n >> 16) & 0xff) / 255,
      ((n >> 8) & 0xff) / 255,
      (n & 0xff) / 255,
    ];
  }
  const s = /^#([0-9a-f]{3})$/i.exec(hex.trim());
  if (s) {
    const [r, g, b] = s[1];
    return [
      parseInt(r + r, 16) / 255,
      parseInt(g + g, 16) / 255,
      parseInt(b + b, 16) / 255,
    ];
  }
  return null;
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  const to = (v: number) =>
    Math.round(clamp01(v) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

export function hexToOklch(hex: string): Oklch | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map(srgbToLinear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.sqrt(A * A + B * B);
  const h = c < 1e-6 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return { l: L, c, h };
}

function oklchToHex({ l, c, h }: Oklch): string {
  // 先做色域收缩：超出 sRGB 时按比例减饱和，而不是硬裁通道（硬裁会偏色）。
  let chroma = c;
  let rgb: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 24; i += 1) {
    const rad = (h * Math.PI) / 180;
    const A = Math.cos(rad) * chroma;
    const B = Math.sin(rad) * chroma;
    const l_ = l + 0.3963377774 * A + 0.2158037573 * B;
    const m_ = l - 0.1055613458 * A - 0.0638541728 * B;
    const s_ = l - 0.0894841775 * A - 1.291485548 * B;
    const ll = l_ * l_ * l_;
    const mm = m_ * m_ * m_;
    const ss = s_ * s_ * s_;
    rgb = [
      4.0767416621 * ll - 3.3077115913 * mm + 0.2309699292 * ss,
      -1.2684380046 * ll + 2.6097574011 * mm - 0.3413193965 * ss,
      -0.0041960863 * ll - 0.7034186147 * mm + 1.707614701 * ss,
    ];
    if (rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4)) break;
    chroma *= 0.94;
  }
  return rgbToHex(rgb.map(linearToSrgb) as [number, number, number]);
}

function lerpHue(a: number, b: number, t: number): number {
  const d = ((b - a + 540) % 360) - 180;
  return (a + d * t + 360) % 360;
}

function mixOklch(a: Oklch, b: Oklch, t: number): Oklch {
  return {
    l: a.l + (b.l - a.l) * t,
    c: a.c + (b.c - a.c) * t,
    h: a.c < 1e-6 ? b.h : b.c < 1e-6 ? a.h : lerpHue(a.h, b.h, t),
  };
}

const SCALE_STEPS = [
  50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950,
] as const;

/** 参考色阶（hex 近似）：决定各档的明度曲线与饱和度分布。 */
const REFERENCE_SCALES: Record<string, string[]> = {
  indigo: [
    "#eef2ff",
    "#e0e7ff",
    "#c7d2fe",
    "#a5b4fc",
    "#818cf8",
    "#6366f1",
    "#4f46e5",
    "#4338ca",
    "#3730a3",
    "#312e81",
    "#1e1b4b",
  ],
  red: [
    "#fef2f2",
    "#fee2e2",
    "#fecaca",
    "#fca5a5",
    "#f87171",
    "#ef4444",
    "#dc2626",
    "#b91c1c",
    "#991b1b",
    "#7f1d1d",
    "#450a0a",
  ],
  amber: [
    "#fffbeb",
    "#fef3c7",
    "#fde68a",
    "#fcd34d",
    "#fbbf24",
    "#f59e0b",
    "#d97706",
    "#b45309",
    "#92400e",
    "#78350f",
    "#451a03",
  ],
  emerald: [
    "#ecfdf5",
    "#d1fae5",
    "#a7f3d0",
    "#6ee7b7",
    "#34d399",
    "#10b981",
    "#059669",
    "#047857",
    "#065f46",
    "#064e3b",
    "#022c22",
  ],
  sky: [
    "#f0f9ff",
    "#e0f2fe",
    "#bae6fd",
    "#7dd3fc",
    "#38bdf8",
    "#0ea5e9",
    "#0284c7",
    "#0369a1",
    "#075985",
    "#0c4a6e",
    "#082f49",
  ],
};

/**
 * 从一个基准色（对应 500 档）推导整条 11 档色阶：
 * 明度整体平移使 500 档精确等于基准色，饱和度按基准色与参考 500 档的比例缩放，
 * 色相取基准色。基准色就是参考色阶的 500 档时，输出约等于参考色阶本身。
 *
 * `scheme='light'` 时整条参考曲线**反向**使用：暗色主题里「亮档当文字、暗档当底」，
 * 浅色主题里角色全部对调（text-indigo-300 要变成深靛蓝才在白底上可读，
 * bg-indigo-950 要变成浅蓝彩底才算「彩色暗块」）——这正是旧实验浅色主题的做法。
 */
/** 明度偏移上限：基准色离参考 500 档太远时（比如挑了个很深的琥珀），整条曲线
 *  若照搬平移，端点的「浅彩底 / 深彩底」会被拖成不深不浅的浑浊色（晨雾的琥珀
 *  警示条就这么脏过）。钳住偏移量，500 档仍精确钉在基准色，两端保持参考曲线
 *  自身的形状。 */
const MAX_DL = 0.08;

export function deriveScale(
  baseHex: string,
  palette: string,
  scheme: "dark" | "light" = "dark",
): string[] {
  const ref = REFERENCE_SCALES[palette] ?? REFERENCE_SCALES.indigo;
  const curve = scheme === "light" ? [...ref].reverse() : ref;
  const base =
    hexToOklch(baseHex) ??
    hexToOklch(
      DEFAULT_SEMANTIC[palette as keyof typeof DEFAULT_SEMANTIC] ?? "#6366f1",
    )!;
  const refOklch = curve.map((hex) => hexToOklch(hex)!);
  const ref500 = refOklch[5];
  const dL = Math.min(MAX_DL, Math.max(-MAX_DL, base.l - ref500.l));
  const kC = ref500.c > 1e-6 ? base.c / ref500.c : 0;
  return refOklch.map((r) =>
    oklchToHex({
      l: clamp01(r.l + dL),
      c: Math.min(r.c * kC, 0.45),
      h: base.c > 1e-6 ? base.h : r.h,
    }),
  );
}

/** 语义槽位 → 调色板名的反查表。 */
const SEMANTIC_PALETTE: Record<string, string> = Object.fromEntries(
  UI_THEME_SEMANTIC_ZONES.filter((z) => z.palette).map((z) => [
    z.id,
    z.palette!,
  ]),
);

/**
 * 按「主背景 / 卡片 / 标题」三个锚点自动铺满全部中性槽位：
 * 其余档位在锚点之间按 OKLCH 明度插值（锚点本身不动）。
 */
export function deriveNeutralRamp(zones: UiThemeZones): UiThemeZones {
  const bg = hexToOklch(zones.bg) ?? hexToOklch(DEFAULT_NEUTRAL.bg)!;
  const card = hexToOklch(zones.card) ?? hexToOklch(DEFAULT_NEUTRAL.card)!;
  const heading =
    hexToOklch(zones.textHeading) ?? hexToOklch(DEFAULT_NEUTRAL.textHeading)!;
  const mix = (a: Oklch, b: Oklch, t: number) => oklchToHex(mixOklch(a, b, t));
  return {
    ...zones,
    surface: mix(bg, card, 0.5),
    control: mix(card, heading, 0.22),
    controlStrong: mix(card, heading, 0.38),
    hoverSoft: zones.card,
    hoverMid: mix(card, heading, 0.22),
    hoverStrong: mix(card, heading, 0.38),
    selected: mix(card, heading, 0.12),
    edgeSubtle: mix(bg, card, 0.8),
    edge: mix(card, heading, 0.16),
    edgeStrong: mix(card, heading, 0.34),
    textMuted: mix(card, heading, 0.52),
    textSecondary: mix(card, heading, 0.68),
    textBright: mix(card, heading, 0.82),
    textBody: mix(card, heading, 0.92),
  };
}

/** 旧存档（中性 10 档）→ 新分区：按旧档位的实际用途补出拆开后的槽位，旧配色逐像素不变。 */
const LEGACY_ZONE_FALLBACK: Record<string, string> = {
  control: "hover",
  controlStrong: "line",
  hoverSoft: "card",
  hoverMid: "hover",
  hoverStrong: "line",
  selected: "card",
  edgeSubtle: "card",
  edge: "hover",
  edgeStrong: "line",
};

/** 规范化：补缺失槽位、丢弃非法颜色（合法集合外的值一律回落默认）。
 *  预设 id 不在册（被移除的预设 / 脏数据）时降级为「自定义」——保住用户已有
 *  配色，界面如实显示自定义而不是冒领某个预设；连分区都没给过的才回默认。
 *  在册预设以代码里的定义为准（存档里的分区只是选中时的快照，预设改版后不能盖住新值）。 */
export function normalizeUiTheme(
  raw: Partial<UiThemeSettings> | null | undefined,
): UiThemeSettings {
  const known =
    typeof raw?.presetId === "string"
      ? getUiThemePreset(raw.presetId)
      : undefined;
  if (known) return { presetId: known.id, zones: { ...known.zones } };

  const source: UiThemeZones = { ...DEFAULT_UI_THEME_ZONES };
  let hasZones = false;
  if (
    raw &&
    typeof raw === "object" &&
    raw.zones &&
    typeof raw.zones === "object"
  ) {
    const stored = raw.zones as Record<string, unknown>;
    const valid = (id: string): string | null => {
      const v = stored[id];
      return typeof v === "string" && hexToRgb(v) ? v.toLowerCase() : null;
    };
    for (const def of UI_THEME_ALL_ZONES) {
      const v = valid(def.id);
      if (v) {
        source[def.id] = v;
        hasZones = true;
      }
    }
    // 旧存档缺的新槽位：跟着旧档位走，而不是回落到暗色默认（否则自定义的浅色主题会冒出暗色边框）
    for (const [id, legacyId] of Object.entries(LEGACY_ZONE_FALLBACK)) {
      if (valid(id)) continue;
      const fallback = valid(legacyId);
      if (fallback) source[id as UiThemeZoneId] = fallback;
    }
  }
  const presetId =
    raw?.presetId === CUSTOM_PRESET_ID || hasZones
      ? CUSTOM_PRESET_ID
      : DEFAULT_PRESET_ID;
  return { presetId, zones: source };
}

/** 由分区颜色推断明暗（自定义主题没有预设可查时用）：主背景的 OKLCH 明度 > 0.6 视为浅色。 */
export function inferScheme(zones: UiThemeZones): "dark" | "light" {
  const bg = hexToOklch(zones.bg);
  return bg && bg.l > 0.6 ? "light" : "dark";
}

/**
 * 由界面分区颜色生成一套终端配色（自定义主题的「从界面配色生成」，以及自定义主题
 * 切换明暗时自动跟随）。底板取同明暗的内置终端预设（黑/白/品红/青等 ANSI 色沿用），
 * 背景、前景、光标、选区来自界面色，红绿黄蓝取语义色基准色——这样终端和界面是一个调子。
 * 终端底取「面板」档：它是桌面画布色（深色下与曜石的终端底 #18181b 同源，浅色下是白）。
 */
export function deriveTerminalColors(zones: UiThemeZones): TerminalColors {
  const light = inferScheme(zones) === "light";
  const base = terminalPreset(light ? "亮色" : "暗色");
  const background = zones.surface;
  const bgOk = hexToOklch(background);
  const accentOk = hexToOklch(zones.accent);
  // 亮/暗档：深色下往亮推、浅色下往深推，保证 bright* 比普通色更「醒目」
  const bright = (hex: string): string => {
    const c = hexToOklch(hex);
    return c
      ? oklchToHex({ ...c, l: clamp01(c.l + (light ? -0.08 : 0.08)) })
      : hex;
  };
  const selection =
    bgOk && accentOk
      ? oklchToHex(mixOklch(bgOk, accentOk, light ? 0.25 : 1))
      : base.selectionBackground;
  return {
    ...base,
    background,
    foreground: zones.textBody,
    cursor: light ? zones.textHeading : zones.textSecondary,
    cursorAccent: background,
    selectionBackground: selection,
    selectionForeground: light ? zones.textHeading : "#ffffff",
    red: zones.danger,
    green: zones.success,
    yellow: zones.warning,
    blue: zones.info,
    brightRed: bright(zones.danger),
    brightGreen: bright(zones.success),
    brightYellow: bright(zones.warning),
    brightBlue: bright(zones.info),
  };
}

export function resolveUiThemeScheme(theme: UiThemeSettings): "dark" | "light" {
  if (theme.presetId !== CUSTOM_PRESET_ID) {
    return getUiThemePreset(theme.presetId)?.scheme ?? "dark";
  }
  return inferScheme(theme.zones);
}

/**
 * 分区 → 要写到 <html> 上的全部 CSS 变量。
 * 中性槽位一一映射 zinc 变量；语义槽位推导 11 档写满对应调色板变量。
 */
export function resolveThemeVars(
  theme: UiThemeSettings,
): Record<string, string> {
  const vars: Record<string, string> = {};
  const scheme = resolveUiThemeScheme(theme);
  for (const def of UI_THEME_NEUTRAL_ZONES) {
    vars[def.cssVar!] = theme.zones[def.id];
  }
  for (const def of UI_THEME_SEMANTIC_ZONES) {
    const palette = SEMANTIC_PALETTE[def.id];
    const scale = deriveScale(theme.zones[def.id], palette, scheme);
    SCALE_STEPS.forEach((step, i) => {
      vars[`--color-${palette}-${step}`] = scale[i];
    });
  }
  return vars;
}

const THEME_CACHE_KEY = "marcel.uiTheme.cache";
/** 外框底色 + 明暗的精简缓存：index.html 的内联脚本在 JS 加载前读它给 <html> 上底色，
 *  冷启动不再先露一块写死的深色。键名与 index.html 一致。 */
const THEME_CHROME_CACHE_KEY = "marcel.uiTheme.chrome";

/* ── 系统外框同步 ──
   窗口之外的东西（Android 状态栏/导航栏图标明暗、窗口与 WebView 的底色）也要跟主题走，
   否则浅色主题下系统栏图标是白的、压在白底上看不见。这里只负责「主题落定后把外框信息
   广播出去」，具体怎么设由各平台订阅者决定（手机见 mobile/mobileBridge.ts）。 */
export interface UiThemeChrome {
  /** 外框底色（手机页底、顶栏的颜色，系统栏透明后透出来的就是它）。 */
  background: string;
  scheme: "dark" | "light";
}

const chromeListeners = new Set<(chrome: UiThemeChrome) => void>();
let lastChrome: UiThemeChrome | null = null;
let chromeTimer: number | undefined;
/** 系统栏图标翻色放在揭开动画播完之后再多等这么久。原生那头设图标明暗、窗口与 WebView
 *  底色会让系统重排一次窗口，放在动画中途就是肉眼可见的顿一下；等圆扫完再做，卡也卡在动画外。 */
const CHROME_SETTLE_MS = 120;

function resolveThemeChrome(theme: UiThemeSettings): UiThemeChrome {
  return {
    background: theme.zones.bg,
    scheme: resolveUiThemeScheme(theme),
  };
}

function notifyChrome(
  listener: (chrome: UiThemeChrome) => void,
  chrome: UiThemeChrome,
): void {
  try {
    listener(chrome);
  } catch {
    // 订阅者出错不能拖垮主题应用。
  }
}

function publishChrome(chrome: UiThemeChrome): void {
  // 底色与明暗都没变就别再通知：原生那头每次都要动系统窗口，拖自定义颜色时尤其频繁
  if (
    lastChrome &&
    lastChrome.background === chrome.background &&
    lastChrome.scheme === chrome.scheme
  ) {
    return;
  }
  lastChrome = chrome;
  for (const listener of chromeListeners) notifyChrome(listener, chrome);
}

/** 订阅外框变化。订阅时若已有落定的主题会立刻回放一次，所以订阅早晚不影响结果。 */
export function onUiThemeChrome(
  listener: (chrome: UiThemeChrome) => void,
): () => void {
  chromeListeners.add(listener);
  if (lastChrome) notifyChrome(listener, lastChrome);
  return () => {
    chromeListeners.delete(listener);
  };
}

/* ── 主题切换过渡 ──
   从点击处向外扩散的圆形揭开（View Transitions）：旧页面快照垫底不动，新页面被一个
   羽化边缘的圆形遮罩从触发点（鼠标/手指落点）推开。动效锚定在用户刚点的那个预设上，
   一眼看得出「是我点的这下换的」；遮罩半径是注册过的 CSS 属性（globals.css），
   羽化边缘靠 mask 渐变实现，WAAPI 直接驱动半径。
   不能改回「给所有元素挂 transition: color」——文字色是继承来的，父元素每渐变一帧
   子元素就重新起一次过渡，文字会比其它颜色慢半拍，还会在摘过渡类时被掐断、闪一下。
   不支持（旧 WebView / 测试环境）或「减少动态效果」时直接换色。 */
type ViewTransitionDocument = {
  startViewTransition?: (update: () => void) => ViewTransition;
};

const REVEAL_MS = 750;
const REVEAL_EASING = "cubic-bezier(0.5, 0, 0.15, 1)";
/** 遮罩羽化带宽度，需与 globals.css 里 mask 渐变的 80px 一致。 */
const REVEAL_FEATHER_PX = 80;
/** 点击到主题应用之间的最长间隔：超过说明不是这次点击触发的（键盘、系统切换、启动同步）。 */
const REVEAL_ORIGIN_MAX_AGE_MS = 1500;

let lastPointer: { x: number; y: number; at: number } | null = null;
if (typeof window !== "undefined") {
  window.addEventListener(
    "pointerdown",
    (e) => {
      lastPointer = { x: e.clientX, y: e.clientY, at: performance.now() };
    },
    { capture: true, passive: true },
  );
}

/** 扩散起点：刚点的位置；没有近期点击（键盘触发等）就从视口中心。 */
function revealOrigin(): { x: number; y: number } {
  if (
    lastPointer &&
    performance.now() - lastPointer.at < REVEAL_ORIGIN_MAX_AGE_MS
  ) {
    return { x: lastPointer.x, y: lastPointer.y };
  }
  return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}

/** 发起一次圆形揭开：先把起点写进变量，快照就绪后驱动遮罩半径从 0 扩到盖满视口。 */
function startRevealTransition(
  doc: ViewTransitionDocument,
  update: () => void,
): void {
  const root = document.documentElement;
  const { x, y } = revealOrigin();
  root.style.setProperty("--marcel-reveal-x", `${x}px`);
  root.style.setProperty("--marcel-reveal-y", `${y}px`);
  const transition = doc.startViewTransition!(update);
  const maxR =
    Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y),
    ) + REVEAL_FEATHER_PX;
  transition.ready
    ?.then(() => {
      root.animate(
        { "--marcel-reveal-r": ["0px", `${maxR}px`] },
        {
          duration: REVEAL_MS,
          easing: REVEAL_EASING,
          fill: "both",
          pseudoElement: "::view-transition-new(root)",
        },
      );
    })
    .catch(() => {
      // 过渡被后一次切换跳过：页面已经直接落到最终状态，无需处理。
    });
}

/** 最近一次要落到 DOM 的主题：过渡回调是异步的，回调里写它而不是调用时的参数，
 *  否则连发时旧回调会把新主题盖回去。 */
let latestTheme: UiThemeSettings | null = null;
/** 上一次应用的「预设 + 明暗」：落到另一个在册预设时才值得揭开。 */
let lastAppliedKey: string | null = null;

/* 「主题已写进 DOM」通知：不是 CSS 变量、而是来自 React 状态的颜色（终端配色预览之类）
   靠它跟着主题揭开的节奏换色，见 hooks/useThemeSynced。 */
const themeWriteListeners = new Set<() => void>();

export function onThemeWritten(listener: () => void): () => void {
  themeWriteListeners.add(listener);
  return () => {
    themeWriteListeners.delete(listener);
  };
}

function writeThemeToDom(theme: UiThemeSettings): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(resolveThemeVars(theme))) {
    root.style.setProperty(name, value);
  }
  const scheme = resolveUiThemeScheme(theme);
  root.style.colorScheme = scheme;
  root.dataset.marcelTheme = scheme;
  // index.html 的内联脚本给了 <html> 一个字面色防冷启动白闪；接管后改成跟变量走，
  // 之后换主题 / 拖颜色，页面边缘与过渡快照的底色都不会停在旧色上。
  root.style.backgroundColor = "var(--color-zinc-950)";
  for (const listener of [...themeWriteListeners]) listener();
}

/** DOM 应用：写变量、切 color-scheme、同步 data-marcel-theme（终端配色联动读它）。
 *  `animate` 控制是否允许整页淡入：启动首帧与早期缓存应用传 false（不欢迎开机动画）。
 *  即使 animate=true，也只在预设或明暗变了时才淡入——自定义里拖颜色要的是即时反馈，
 *  不是每改一下都淡一次（淡入期间的后续写入会实时出现在「新页面」层里）。 */
export function applyUiTheme(theme: UiThemeSettings, animate = true): void {
  if (typeof document === "undefined") return;
  latestTheme = theme;
  const chrome = resolveThemeChrome(theme);
  try {
    localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(theme));
    localStorage.setItem(THEME_CHROME_CACHE_KEY, JSON.stringify(chrome));
  } catch {
    // 存储不可用（隐私 WebView）时跳过缓存，设置加载后会再应用一次。
  }
  const key = `${theme.presetId}|${resolveUiThemeScheme(theme)}`;
  // 只有「落到某个在册预设」才值得揭开。落到「自定义」（编辑器里一改色 presetId 就变成
  // custom）一律直接生效：揭开期间圆外是冻结的旧快照，拖颜色会大半屏不跟手。
  const changed =
    lastAppliedKey !== null &&
    lastAppliedKey !== key &&
    getUiThemePreset(theme.presetId) !== undefined;
  lastAppliedKey = key;

  const doc = document as unknown as ViewTransitionDocument;
  const reduceMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (animate && changed && !reduceMotion && doc.startViewTransition) {
    startRevealTransition(doc, () => {
      if (latestTheme) writeThemeToDom(latestTheme);
    });
    // 系统栏图标等圆扫完再翻（见 CHROME_SETTLE_MS）：动画中途动系统窗口会顿一下。
    window.clearTimeout(chromeTimer);
    chromeTimer = window.setTimeout(() => {
      if (latestTheme) publishChrome(resolveThemeChrome(latestTheme));
    }, REVEAL_MS + CHROME_SETTLE_MS);
    return;
  }
  writeThemeToDom(theme);
  window.clearTimeout(chromeTimer);
  publishChrome(chrome);
}

/**
 * 启动早期同步应用（在 React 挂载前跑，避免浅色主题用户先看到一帧深色）。
 * 只信缓存的合法值；设置加载后 useUiTheme 会以真实设置覆盖。
 */
export function initUiThemeEarly(): void {
  if (typeof document === "undefined" || typeof localStorage === "undefined")
    return;
  try {
    const cached = localStorage.getItem(THEME_CACHE_KEY);
    if (!cached) return;
    applyUiTheme(
      normalizeUiTheme(JSON.parse(cached) as Partial<UiThemeSettings>),
      false,
    );
  } catch {
    // 缓存损坏就忽略，等设置加载。
  }
}
