import type { AppearanceSettings, AppearanceTheme } from '@/lib/types';

/**
 * Appearance runtime: applies the WinUI theme + Acrylic window backdrop.
 *
 * - data-theme on <html> drives the light/dark token sets (winui.css).
 * - data-acrylic on <html> turns the window background transparent so the
 *   native DWM acrylic (Tauri window effects) can show the desktop through.
 * - When running in a plain browser (no Tauri) the same CSS layers still
 *   render a light Fluent look; the native effect call simply no-ops.
 */

const HLJS_LIGHT = 'highlight.js/styles/github.css';
const HLJS_DARK = 'highlight.js/styles/github-dark.css';
const HLJS_ID = 'marcel-hljs-theme';

export function resolveAppearanceTheme(theme: AppearanceTheme): 'light' | 'dark' {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return theme;
}

function setHljsTheme(mode: 'light' | 'dark') {
  const href = mode === 'dark' ? HLJS_DARK : HLJS_LIGHT;
  let link = document.getElementById(HLJS_ID) as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement('link');
    link.id = HLJS_ID;
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
  const resolved = new URL(href, window.location.href).href;
  if (link.href !== resolved) link.href = href;
}

export function applyAppearance(appearance: AppearanceSettings) {
  const root = document.documentElement;
  const theme = appearance?.theme ?? 'light';
  const acrylic = appearance?.acrylic ?? true;
  root.dataset.theme = theme;
  root.style.colorScheme = theme === 'system' ? 'light dark' : theme;
  setHljsTheme(resolveAppearanceTheme(theme));
  const isMobile = root.dataset.marcelPlatform === 'mobile';
  root.dataset.acrylic = !isMobile && acrylic ? 'true' : 'false';
}

/**
 * Applies / clears the native window backdrop (WinUI Acrylic on Windows).
 * Browser preview and unsupported platforms fall back to CSS only.
 *
 * 桌面端模糊依赖原生 DWM 效果（CSS backdrop-filter 无法模糊窗口外的桌面）。
 * 窗口创建初期（visible:false）调用可能不生效，这里会延迟重试几次，
 * Acrylic 不可用时回退到 Mica（同样带模糊），仍失败则保持 CSS-only（透出但无模糊）。
 */
export async function applyWindowAcrylic(enabled: boolean): Promise<void> {
  const root = document.documentElement;
  if (root.dataset.marcelPlatform === 'mobile') return;

  const setNative = (v: boolean) => {
    root.dataset.nativeAcrylic = v ? 'true' : 'false';
  };

  if (!enabled) {
    setNative(false);
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().clearEffects();
    } catch (err) {
      console.warn('[appearance] clearEffects failed:', err);
    }
    return;
  }

  const attempt = async (): Promise<boolean> => {
    try {
      const { getCurrentWindow, Effect } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      try {
        await win.setEffects({ effects: [Effect.Acrylic] });
      } catch {
        // 部分系统/版本不支持 Acrylic，回退 Mica（同样带模糊）
        await win.setEffects({ effects: [Effect.Mica] });
      }
      setNative(true);
      return true;
    } catch (err) {
      setNative(false);
      console.warn('[appearance] native window effects unavailable:', err);
      return false;
    }
  };

  // 立即尝试；窗口刚创建（visible:false）时可能不生效，错峰重试
  if (await attempt()) return;
  for (const delay of [300, 1200, 3000]) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (await attempt()) return;
  }
}

/** Subscribes to OS light/dark changes (used when theme === 'system'). */
export function watchSystemTheme(onChange: () => void): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
