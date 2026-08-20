import { useMemo } from 'react';
import type { PluginManifest, MarketPlugin } from '@/lib/types';
import { isNewerVersion } from '@/lib/semver';

export interface PluginUpdateInfo {
  localVersion: string;
  marketVersion: string;
  marketPlugin: MarketPlugin;
}

/**
 * Compute which installed plugins have a newer version available on the market.
 * `marketPlugins` comes from `useMarketStore().plugins`.
 */
export function usePluginUpdates(
  manifests: PluginManifest[],
  marketPlugins: MarketPlugin[],
): Map<string, PluginUpdateInfo> {
  return useMemo(() => {
    const marketMap = new Map<string, MarketPlugin>();
    for (const p of marketPlugins) marketMap.set(p.id, p);
    const out = new Map<string, PluginUpdateInfo>();
    for (const m of manifests) {
      const mp = marketMap.get(m.id);
      if (!mp) continue;
      if (!mp.version || !m.version) continue;
      if (isNewerVersion(mp.version, m.version)) {
        out.set(m.id, { localVersion: m.version, marketVersion: mp.version, marketPlugin: mp });
      }
    }
    return out;
  }, [manifests, marketPlugins]);
}
