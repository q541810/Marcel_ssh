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
 */
export async function applyWindowAcrylic(enabled: boolean): Promise<void> {
  const root = document.documentElement;
  if (root.dataset.marcelPlatform === 'mobile') return;
  try {
    const { getCurrentWindow, Effect } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    if (enabled) {
      await win.setEffects({ effects: [Effect.Acrylic] });
      root.dataset.nativeAcrylic = 'true';
    } else {
      await win.clearEffects();
      root.dataset.nativeAcrylic = 'false';
    }
  } catch (err) {
    // Non-Tauri (browser preview) or unsupported platform: CSS-only fallback.
    root.dataset.nativeAcrylic = 'false';
    console.debug('[appearance] native window effects unavailable:', err);
  }
}

/** Subscribes to OS light/dark changes (used when theme === 'system'). */
export function watchSystemTheme(onChange: () => void): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
