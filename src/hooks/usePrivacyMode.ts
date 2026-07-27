import { useSettingsStore } from '@/stores/settingsStore';

/** 读取 settings.privacyMode。组件里用，配合 privacy.ts 的脱敏函数。 */
export function usePrivacyMode(): boolean {
  return useSettingsStore((s) => s.settings.privacyMode ?? false);
}
