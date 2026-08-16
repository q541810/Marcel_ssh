import { describe, it, expect } from 'vitest';
import {
  mapStoreQuickCommands,
  MOBILE_DEFAULT_QUICK_COMMANDS,
  resolveMobileQuickCommands,
  toExecutableQuickCommand,
} from './quickCommands';

describe('mobile quick commands', () => {
  it('provides default fallback commands', () => {
    expect(MOBILE_DEFAULT_QUICK_COMMANDS.map((c) => c.lines[0])).toEqual([
      'ls -la',
      'cd ..',
      'git status',
      'pwd',
      'htop',
    ]);
  });

  it('keeps all lines of store multi-line commands (not just the first)', () => {
    expect(
      mapStoreQuickCommands([
        {
          id: '1',
          name: '部署',
          commands: ['git pull', 'pnpm build', ' pm2 restart app '],
          intervalMs: 500,
          insertOnly: true,
        },
        { id: '2', name: '空', commands: ['', '  '], intervalMs: 0 },
        { id: '3', name: '', commands: ['  pwd  '], intervalMs: 0 },
      ]),
    ).toEqual([
      {
        id: '1',
        label: '部署',
        lines: ['git pull', 'pnpm build', 'pm2 restart app'],
        intervalMs: 500,
        insertOnly: true,
      },
      {
        id: '3',
        label: 'pwd',
        lines: ['pwd'],
        intervalMs: 0,
        insertOnly: false,
      },
    ]);
  });

  it('falls back to defaults when store has no usable commands', () => {
    expect(resolveMobileQuickCommands([])).toBe(MOBILE_DEFAULT_QUICK_COMMANDS);
    expect(
      resolveMobileQuickCommands([
        { id: 'x', name: 'x', commands: [], intervalMs: 0 },
      ]),
    ).toBe(MOBILE_DEFAULT_QUICK_COMMANDS);
  });

  it('prefers store commands when available', () => {
    const store = [
      {
        id: 'a',
        name: '自定义',
        commands: ['echo hi'],
        intervalMs: 100,
        insertOnly: false,
      },
    ];
    expect(resolveMobileQuickCommands(store)).toEqual([
      {
        id: 'a',
        label: '自定义',
        lines: ['echo hi'],
        intervalMs: 100,
        insertOnly: false,
      },
    ]);
  });

  it('converts a chip to a store-executable QuickCommand shape', () => {
    const cmd = toExecutableQuickCommand({
      id: 'a',
      label: '部署',
      lines: ['git pull', 'pnpm build'],
      intervalMs: 300,
      insertOnly: true,
    });
    expect(cmd.commands).toEqual(['git pull', 'pnpm build']);
    expect(cmd.intervalMs).toBe(300);
    expect(cmd.insertOnly).toBe(true);
    expect(cmd.id).toBe('a');
  });
});
