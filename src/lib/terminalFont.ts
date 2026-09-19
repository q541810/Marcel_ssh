/**
 * 终端字体栈的单一来源。
 *
 * 为什么不能把设置里的字体值直接丢给 xterm（issue #15）：
 *
 * 1. 字体设置是自由文本。名字写错 / 没装时，浏览器会回退到**比例字体**，而 xterm
 *    的字符格子宽度是用该字体的 "W" 量出来的（Arial/Times 下约 0.94em），于是窄
 *    字符（i、l、空格）被撑进一个宽格子 —— 表现就是「命令行字间距异常」。
 * 2. Nerd Fonts 的字形只存在于用户自己装的字体里，没装就是豆腐块，而很多 Linux
 *    工具（p10k、nvim、tmux 状态栏…）输出这类图标。
 *
 * 所以下发给 xterm 的字体栈统一由这里构造：
 *
 *     用户选的字体 → 内置 Nerd Font（随包分发，补图标）→ monospace（保底）
 *
 * 内置字体只作为兜底家族出现在栈里：ASCII 仍由用户字体渲染，字距不会受影响；
 * 用户字体缺少的图标字形由内置字体补上。即使字体名整个写错，最后也有 monospace
 * 顶着，不会退化成比例字体。
 */

/** 内置 Nerd Font 的 CSS 家族名（@font-face 见 styles/globals.css，字体文件在 public/fonts/）。 */
export const BUNDLED_NERD_FONT_FAMILY = 'Marcel Nerd Font Mono';

/**
 * 探测内置字体用的字符：Powerline 分隔符（U+E0B0，Nerd Fonts 私有区）。
 * 普通系统字体没有这个字形，用它来强制加载内置字体。
 */
const BUNDLED_NERD_FONT_PROBE = '\uE0B0';

/** 真正兜底用的通用家族：栈里没有它们时补一个，保证终端永远是等宽。 */
const GENERIC_FAMILIES = new Set([
  'monospace',
  'ui-monospace',
  'sans-serif',
  'serif',
  'system-ui',
  'cursive',
  'fantasy',
  'math',
  'emoji',
  'fangsong',
]);

const QUOTES = /^["']|["']$/g;

function unquote(token: string): string {
  return token.replace(QUOTES, '').trim();
}

function normalize(token: string): string {
  return unquote(token).toLowerCase();
}

/** 单个字体族是否就是内置 Nerd Font（忽略引号与大小写）。 */
export function isBundledNerdFontFamily(token: string): boolean {
  return normalize(token) === BUNDLED_NERD_FONT_FAMILY.toLowerCase();
}

/**
 * 按 CSS 规则切分字体列表：逗号分隔，引号内的逗号不算分隔符。
 * 保留 token 原文（含引号），只去掉首尾空白。
 */
export function parseFontFamilies(value: string): string[] {
  const families: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ',') {
      families.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  families.push(current);

  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of families) {
    const token = raw.trim();
    if (!token) continue;
    const key = normalize(token);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(token);
  }
  return result;
}

/**
 * 把设置里的字体值构建成真正下发给 xterm 的字体栈。
 *
 * - 空值：只给内置 Nerd Font + monospace（终端仍然是等宽的完整 Nerd Font）
 * - 用户字体里有通用家族（monospace/sans-serif/…）：内置字体插在它前面
 * - 没有通用家族：内置字体接在用户字体后面，末尾补 monospace
 * - 用户自己写了内置字体名：不重复插入
 */
export function buildTerminalFontFamily(value: string | null | undefined): string {
  const families = parseFontFamilies(value ?? '');
  const hasBundled = families.some(isBundledNerdFontFamily);
  if (!hasBundled) {
    const genericIndex = families.findIndex((f) => GENERIC_FAMILIES.has(normalize(f)));
    const insertAt = genericIndex === -1 ? families.length : genericIndex;
    families.splice(insertAt, 0, `"${BUNDLED_NERD_FONT_FAMILY}"`);
  }
  const hasGeneric = families.some((f) => GENERIC_FAMILIES.has(normalize(f)));
  if (!hasGeneric) families.push('monospace');
  return families.join(', ');
}

let loadPromise: Promise<boolean> | null = null;
let loaded = false;
const readyCallbacks: Array<() => void> = [];

/** 重试间隔与次数：@font-face 是样式表里的规则，注册可能晚于 JS 执行（生产构建是 <link>）。 */
const LOAD_RETRY_INTERVAL_MS = 100;
const LOAD_RETRY_LIMIT = 40;

function notifyReady(): void {
  const callbacks = readyCallbacks.splice(0, readyCallbacks.length);
  for (const cb of callbacks) {
    try {
      cb();
    } catch (err) {
      console.warn('[terminalFont] 内置字体就绪回调失败:', err);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadBundledNerdFont(fonts: FontFaceSet): Promise<boolean> {
  const spec = `16px "${BUNDLED_NERD_FONT_FAMILY}"`;
  for (let attempt = 0; attempt < LOAD_RETRY_LIMIT; attempt++) {
    if (attempt > 0) await delay(LOAD_RETRY_INTERVAL_MS);
    try {
      const faces = await fonts.load(spec, BUNDLED_NERD_FONT_PROBE);
      if (faces.length > 0) return true;
    } catch (err) {
      console.warn('[terminalFont] 内置 Nerd Font 加载失败:', err);
      return false;
    }
  }
  return false;
}

/**
 * 加载内置字体（幂等）。字体是本地资源，通常毫秒级完成。
 *
 * 必须在第一个图标字形被画到画布之前完成：xterm 的 WebGL / Canvas 渲染器会把栅格化
 * 结果缓存进纹理图集，字体没就绪时画出来的缺字会被缓存住，直到图集被清空。
 */
export function ensureBundledNerdFontLoaded(): Promise<boolean> {
  if (loadPromise) return loadPromise;
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
  if (!fonts) {
    // 测试 / 非浏览器环境：没有字体系统，视为已就绪（不阻塞任何调用方）。
    loaded = true;
    loadPromise = Promise.resolve(true);
    return loadPromise;
  }
  loadPromise = loadBundledNerdFont(fonts)
    .then((ok) => {
      loaded = ok;
      if (!ok) {
        console.warn(
          `[terminalFont] 内置 Nerd Font「${BUNDLED_NERD_FONT_FAMILY}」未加载成功，图标将回退到用户字体`,
        );
      }
      return ok;
    })
    .finally(() => {
      notifyReady();
    });
  return loadPromise;
}

/** 内置字体是否已就绪。 */
export function isBundledNerdFontLoaded(): boolean {
  return loaded;
}

/**
 * 注册「内置字体就绪」回调；已就绪时立即（微任务）回调。返回退订函数。
 * 用途：字体就绪晚于终端创建时，清掉图集里按缺字缓存的图标字形。
 */
export function onBundledNerdFontReady(cb: () => void): () => void {
  if (loaded) {
    void Promise.resolve().then(cb);
    return () => {};
  }
  readyCallbacks.push(cb);
  return () => {
    const index = readyCallbacks.indexOf(cb);
    if (index >= 0) readyCallbacks.splice(index, 1);
  };
}

// 模块级启动加载：终端相关代码首次被 import 时就开跑，尽早进入字体缓存。
void ensureBundledNerdFontLoaded();
