import { invoke } from '@tauri-apps/api/core';

/** 插件提交仓库：作者把自研插件提交到市场。 */
export const PLUGIN_SUBMIT_URL = 'https://github.com/q541810/marcel-ssh-plugins';

/** 官方技术支持 / Bug 反馈（QQ 群聊）。 */
export const SUPPORT_URL = 'https://qm.qq.com/q/n2FDryzDHi';

/**
 * Open a URL in the system browser.
 *
 * Must go through our Rust command (`open_external_url` → ShellExt::open),
 * not `@tauri-apps/plugin-shell`'s JS `open()`. On Android the latter invokes
 * the desktop `open` crate (xdg-open) and never starts a browser Intent.
 */
export function openExternalLink(url: string): void {
  if (!url) return;
  invoke('open_external_url', { url }).catch((err) => {
    console.error('Failed to open external link:', err);
  });
}
