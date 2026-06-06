import { open } from '@tauri-apps/plugin-shell';

export function openExternalLink(url: string): void {
  open(url).catch((err) => {
    console.error('Failed to open external link:', err);
  });
}
