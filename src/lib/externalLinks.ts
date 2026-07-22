import { invoke } from '@tauri-apps/api/core';

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
