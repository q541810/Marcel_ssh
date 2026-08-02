/**
 * Lenient dot-separated numeric version comparison used for plugin
 * `minAppVersion` checks. Mirrors the backend logic in
 * `src-tauri/src/plugins/registry.rs` (`min_app_version_satisfied`) — keep the
 * two in sync.
 */

function parseVersionParts(s: string): number[] | null {
  const parts: number[] = [];
  for (const seg of s.split('.')) {
    const trimmed = seg.trim();
    // Only plain digits — mirrors Rust's `parse::<u64>()` which rejects
    // scientific notation ("1e2"), hex ("0x10"), etc. `Number()` would
    // accept those, causing a frontend/backend mismatch.
    if (!/^\d+$/.test(trimmed)) return null;
    parts.push(Number(trimmed));
  }
  return parts;
}

/**
 * Whether `appVersion` satisfies `minVersion`. Missing segments count as 0,
 * so "1.7" satisfies "1.7.0" and vice versa. A malformed version string is
 * treated as NOT satisfied (conservative — an incompatible plugin stays
 * disabled rather than silently running).
 */
export function satisfiesMinVersion(appVersion: string, minVersion: string): boolean {
  const appParts = parseVersionParts(appVersion);
  const minParts = parseVersionParts(minVersion);
  if (appParts === null || minParts === null) return false;
  const len = Math.max(appParts.length, minParts.length);
  for (let i = 0; i < len; i++) {
    const a = appParts[i] ?? 0;
    const m = minParts[i] ?? 0;
    if (a < m) return false;
    if (a > m) return true;
  }
  return true;
}
