import type { AgentMode } from '@/lib/types';
import { appReady, checkUpdate } from '@/lib/tauri';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTaskStore } from '@/stores/taskStore';
import { useSkillStore } from '@/stores/skillStore';
import { attachTransferListeners } from '@/stores/sftpTransferManager';

const VALID_AGENT_MODES: readonly AgentMode[] = ['plan', 'agent', 'auto'];

export function resolveBootstrapMode(
  defaultAgentMode: string | undefined | null,
): AgentMode | null {
  if (!defaultAgentMode) return null;
  if ((VALID_AGENT_MODES as readonly string[]).includes(defaultAgentMode)) {
    return defaultAgentMode as AgentMode;
  }
  return null;
}

export interface MobileBootstrapDeps {
  /** Window starts visible:false — must show early (desktop App does this). */
  appReady: () => Promise<void>;
  loadSettings: () => Promise<void>;
  getDefaultAgentMode: () => string | undefined | null;
  setMode: (mode: AgentMode) => void;
  fetchSkills: () => Promise<void>;
  attachTransferListeners: () => void | Promise<void>;
  checkUpdate: () => Promise<{
    hasUpdate: boolean;
    latestVersion: string;
    releaseUrl: string;
  }>;
  onUpdateAvailable: (version: string, url: string) => void;
}

export async function runMobileBootstrap(
  deps: MobileBootstrapDeps,
): Promise<void> {
  // Show window first so a hung settings/skills load never leaves a blank process.
  try {
    await deps.appReady();
  } catch {
    /* browser preview has no tauri */
  }
  await deps.loadSettings();
  const mode = resolveBootstrapMode(deps.getDefaultAgentMode());
  if (mode) {
    deps.setMode(mode);
  }
  try {
    await deps.fetchSkills();
  } catch {
    /* best-effort */
  }
  await deps.attachTransferListeners();
  // Update check last and silent-on-failure: never blocks interaction.
  try {
    const result = await deps.checkUpdate();
    if (result.hasUpdate) {
      deps.onUpdateAvailable(result.latestVersion, result.releaseUrl);
    }
  } catch {
    /* offline / server unreachable — stay silent */
  }
}

let bootstrapStarted = false;

export interface MobileBootstrapCallbacks {
  onUpdateAvailable: (version: string, url: string) => void;
}

export async function bootstrapMobileApp(
  callbacks: MobileBootstrapCallbacks,
): Promise<void> {
  if (bootstrapStarted) return;
  bootstrapStarted = true;
  try {
    await runMobileBootstrap({
      appReady: () => appReady(),
      loadSettings: () => useSettingsStore.getState().load(),
      getDefaultAgentMode: () =>
        useSettingsStore.getState().settings.defaultAgentMode,
      setMode: (mode) => useTaskStore.getState().setMode(mode),
      fetchSkills: () => useSkillStore.getState().fetchSkills(),
      attachTransferListeners: () => attachTransferListeners(),
      checkUpdate: () => checkUpdate(),
      onUpdateAvailable: callbacks.onUpdateAvailable,
    });
  } catch (err) {
    bootstrapStarted = false;
    console.error('[mobile] bootstrap failed:', err);
    throw err;
  }
}

export function resetMobileBootstrapForTests(): void {
  bootstrapStarted = false;
}
