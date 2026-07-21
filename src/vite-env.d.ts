/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly TAURI_ENV_PLATFORM?: string;
  readonly TAURI_PLATFORM?: string;
  readonly TAURI_DEBUG?: string;
  /** Set by `pnpm tauri:dev:mobile` / `.env.mobile` to force phone UI shell */
  readonly VITE_FORCE_PLATFORM?: 'mobile' | 'desktop' | string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
