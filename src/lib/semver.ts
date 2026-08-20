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
 * Compare two dot-separated numeric versions.
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 * Malformed segments (non-digits) => null (conservative).
 * Missing segments count as 0, so "1.7" == "1.7.0".
 */
export function compareVersions(a: string, b: string): number | null {
  const aParts = parseVersionParts(a);
  const bParts = parseVersionParts(b);
  if (aParts === null || bParts === null) return null;
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const av = aParts[i] ?? 0;
    const bv = bParts[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

/**
 * Whether `marketVersion` is newer than `localVersion`.
 * Malformed => false (no update prompt).
 */
export function isNewerVersion(marketVersion: string, localVersion: string): boolean {
  const cmp = compareVersions(marketVersion, localVersion);
  return cmp === 1;
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
