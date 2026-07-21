export type AppPlatform = 'desktop' | 'mobile';

export interface PlatformHints {
  os?: string;
  userAgent?: string;
  maxTouchPoints?: number;
  pointerCoarse?: boolean;
  width?: number;
  force?: AppPlatform;
}

const MOBILE_OS = new Set(['android', 'ios']);
const DESKTOP_OS = new Set([
  'windows',
  'macos',
  'linux',
  'freebsd',
  'dragonfly',
  'netbsd',
  'openbsd',
  'solaris',
]);

function isMobileUserAgent(userAgent: string): boolean {
  return /Android|iPhone|iPad|iPod|Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(
    userAgent,
  );
}

export function getAppPlatform(hints: PlatformHints = {}): AppPlatform {
  if (hints.force === 'mobile' || hints.force === 'desktop') {
    return hints.force;
  }

  const os = hints.os?.toLowerCase();
  if (os && MOBILE_OS.has(os)) {
    return 'mobile';
  }
  if (os && DESKTOP_OS.has(os)) {
    return 'desktop';
  }

  if (hints.userAgent && isMobileUserAgent(hints.userAgent)) {
    return 'mobile';
  }

  if (
    hints.pointerCoarse === true &&
    (hints.maxTouchPoints ?? 0) > 0 &&
    (hints.width ?? Number.POSITIVE_INFINITY) < 900
  ) {
    return 'mobile';
  }

  return 'desktop';
}

export function isMobilePlatform(hints?: PlatformHints): boolean {
  return getAppPlatform(hints) === 'mobile';
}

function readForcedPlatform(
  search?: string,
  hash?: string,
  envForce?: string,
  storageForce?: string | null,
): AppPlatform | undefined {
  if (envForce === 'mobile' || envForce === 'desktop') return envForce;
  if (storageForce === 'mobile' || storageForce === 'desktop') return storageForce;

  if (search) {
    const forced = new URLSearchParams(search).get('platform');
    if (forced === 'mobile' || forced === 'desktop') return forced;
  }

  // Support #platform=mobile (some embeds strip query on load)
  if (hash) {
    const raw = hash.startsWith('#') ? hash.slice(1) : hash;
    const forced =
      new URLSearchParams(raw).get('platform') ??
      (raw === 'platform=mobile' || raw === 'mobile'
        ? 'mobile'
        : raw === 'platform=desktop' || raw === 'desktop'
          ? 'desktop'
          : null);
    if (forced === 'mobile' || forced === 'desktop') return forced;
  }

  return undefined;
}

export function collectPlatformHints(
  env: {
    tauriPlatform?: string;
    userAgent?: string;
    maxTouchPoints?: number;
    pointerCoarse?: boolean;
    width?: number;
    search?: string;
    hash?: string;
    envForce?: string;
    storageForce?: string | null;
  } = {},
): PlatformHints {
  const search =
    env.search ??
    (typeof window !== 'undefined' ? window.location.search : undefined);
  const hash =
    env.hash ?? (typeof window !== 'undefined' ? window.location.hash : undefined);

  let storageForce = env.storageForce;
  if (storageForce === undefined && typeof localStorage !== 'undefined') {
    try {
      storageForce = localStorage.getItem('marcel.forcePlatform');
    } catch {
      storageForce = null;
    }
  }

  // Prefer explicit VITE_FORCE_PLATFORM; also treat Vite --mode mobile as force
  // (envPrefix must include VITE_ or the var never reaches the client).
  const envForce =
    env.envForce ??
    (import.meta.env.VITE_FORCE_PLATFORM as string | undefined) ??
    (import.meta.env.MODE === 'mobile' ? 'mobile' : undefined);

  // Priority: env (dev script) > storage > URL/hash
  // Only URL/hash writes storage — so `pnpm tauri:dev:mobile` does not permanently stick.
  const urlForce = readForcedPlatform(search, hash, undefined, undefined);
  if (urlForce && typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem('marcel.forcePlatform', urlForce);
    } catch {
      /* ignore */
    }
  }

  const force = readForcedPlatform(search, hash, envForce, storageForce ?? null);
  if (force) {
    return { force };
  }

  const tauriPlatform =
    env.tauriPlatform ??
    import.meta.env.TAURI_ENV_PLATFORM ??
    import.meta.env.TAURI_PLATFORM;

  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const win = typeof window !== 'undefined' ? window : undefined;

  return {
    os: tauriPlatform,
    userAgent: env.userAgent ?? nav?.userAgent,
    maxTouchPoints: env.maxTouchPoints ?? nav?.maxTouchPoints,
    pointerCoarse:
      env.pointerCoarse ??
      (typeof win?.matchMedia === 'function'
        ? win.matchMedia('(pointer: coarse)').matches
        : undefined),
    width: env.width ?? win?.innerWidth,
  };
}

/** Persist force for Tauri window (devUrl has no query string). */
export function setForcedPlatform(platform: AppPlatform | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (platform == null) {
      localStorage.removeItem('marcel.forcePlatform');
    } else {
      localStorage.setItem('marcel.forcePlatform', platform);
    }
  } catch {
    /* ignore */
  }
}
