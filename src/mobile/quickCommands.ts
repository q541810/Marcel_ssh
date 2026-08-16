import type { QuickCommand } from '@/lib/types';

export interface MobileQuickCommand {
  id: string;
  label: string;
  /** All command lines — executed sequentially with intervalMs between them. */
  lines: string[];
  intervalMs: number;
  /** 仅插入内容（最后一行不回车），不自动执行 */
  insertOnly: boolean;
}

/** Fallback when store empty / load failed — still usable offline. */
export const MOBILE_DEFAULT_QUICK_COMMANDS: readonly MobileQuickCommand[] = [
  { id: 'ls', label: 'ls -la', lines: ['ls -la'], intervalMs: 0, insertOnly: false },
  { id: 'cd-up', label: 'cd ..', lines: ['cd ..'], intervalMs: 0, insertOnly: false },
  {
    id: 'git-status',
    label: 'git status',
    lines: ['git status'],
    intervalMs: 0,
    insertOnly: false,
  },
  { id: 'pwd', label: 'pwd', lines: ['pwd'], intervalMs: 0, insertOnly: false },
  { id: 'htop', label: 'htop', lines: ['htop'], intervalMs: 0, insertOnly: false },
];

/** Map desktop QuickCommand store items to mobile chips, keeping every line. */
export function mapStoreQuickCommands(
  commands: ReadonlyArray<{
    id: string;
    name: string;
    commands: string[];
    intervalMs: number;
    insertOnly?: boolean;
  }>,
): MobileQuickCommand[] {
  return commands
    .map((cmd) => {
      const lines = cmd.commands.map((c) => c.trim()).filter(Boolean);
      if (lines.length === 0) return null;
      return {
        id: cmd.id,
        label: cmd.name.trim() || lines[0],
        lines,
        intervalMs: cmd.intervalMs,
        insertOnly: cmd.insertOnly ?? false,
      };
    })
    .filter((c): c is MobileQuickCommand => c != null);
}

export function resolveMobileQuickCommands(
  storeCommands: ReadonlyArray<{
    id: string;
    name: string;
    commands: string[];
    intervalMs: number;
    insertOnly?: boolean;
  }>,
): readonly MobileQuickCommand[] {
  const mapped = mapStoreQuickCommands(storeCommands);
  return mapped.length > 0 ? mapped : MOBILE_DEFAULT_QUICK_COMMANDS;
}

/** Adapt a chip back to the QuickCommand shape `quickCommandStore.execute` expects. */
export function toExecutableQuickCommand(
  chip: MobileQuickCommand,
): QuickCommand {
  return {
    id: chip.id,
    scope: 'global',
    sessionKey: null,
    name: chip.label,
    commands: chip.lines,
    intervalMs: chip.intervalMs,
    insertOnly: chip.insertOnly,
    createdAt: '',
    updatedAt: '',
  };
}
