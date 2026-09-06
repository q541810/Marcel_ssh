import { describe, it, expect } from 'vitest';
import type { Session, SftpFileEntry } from '@/lib/types';
import type { StoredTransferItem } from '@/stores/transferStore';
import {
  sortFileEntries,
  joinRemotePath,
  parentPath,
  filesEmptyStateReason,
  resolveFilesSessionIds,
  resolveRememberedPath,
  transferProgressPercent,
  shouldPersistFileManagerPath,
  buildFileManagerPathsPatch,
  isImageFileName,
  isProbablyTextFileName,
  openFileKind,
  filesListLoadingMode,
  toggleSelectionName,
  canQuickDelete,
  batchDeleteProgressText,
  defaultArchiveTargetPath,
  latestTransferFailure,
} from './filesUi';

function session(
  partial: Partial<Session> & Pick<Session, 'id' | 'status'>,
): Session {
  return {
    connectionId: 'user@host:22',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

function entry(
  partial: Partial<SftpFileEntry> & Pick<SftpFileEntry, 'name'>,
): SftpFileEntry {
  return {
    is_dir: false,
    is_file: true,
    is_symlink: false,
    size: 0,
    mode: 0o644,
    ...partial,
  };
}

describe('sortFileEntries', () => {
  it('puts directories first then sorts by name case-insensitively', () => {
    const input = [
      entry({ name: 'zebra.txt' }),
      entry({ name: 'Docs', is_dir: true, is_file: false }),
      entry({ name: 'alpha.txt' }),
      entry({ name: 'bin', is_dir: true, is_file: false }),
    ];
    expect(sortFileEntries(input).map((e) => e.name)).toEqual([
      'bin',
      'Docs',
      'alpha.txt',
      'zebra.txt',
    ]);
  });

  it('filters hidden entries when showHidden is false', () => {
    const input = [
      entry({ name: '.git', is_dir: true, is_file: false }),
      entry({ name: 'visible.txt' }),
      entry({ name: '.env' }),
    ];
    expect(sortFileEntries(input, false).map((e) => e.name)).toEqual([
      'visible.txt',
    ]);
    expect(sortFileEntries(input, true).map((e) => e.name)).toEqual([
      '.git',
      '.env',
      'visible.txt',
    ]);
  });

  it('does not mutate the original array', () => {
    const input = [entry({ name: 'b' }), entry({ name: 'a' })];
    const copy = [...input];
    sortFileEntries(input);
    expect(input).toEqual(copy);
  });
});

describe('joinRemotePath', () => {
  it('joins under root without double slash', () => {
    expect(joinRemotePath('/', 'etc')).toBe('/etc');
  });

  it('joins under nested directory', () => {
    expect(joinRemotePath('/home/user', 'docs')).toBe('/home/user/docs');
  });

  it('strips trailing slash on parent', () => {
    expect(joinRemotePath('/home/', 'user')).toBe('/home/user');
  });
});

describe('parentPath', () => {
  it('returns root parent as root', () => {
    expect(parentPath('/')).toBe('/');
    expect(parentPath('')).toBe('/');
  });

  it('returns parent of nested path', () => {
    expect(parentPath('/home/user/docs')).toBe('/home/user');
    expect(parentPath('/home')).toBe('/');
  });

  it('handles trailing slash', () => {
    expect(parentPath('/home/user/')).toBe('/home');
  });
});

describe('filesEmptyStateReason', () => {
  it('returns no-session when session is null', () => {
    expect(filesEmptyStateReason(null)).toBe('no-session');
  });

  it('maps session status to empty-state reasons', () => {
    expect(
      filesEmptyStateReason(session({ id: 's1', status: 'connecting' })),
    ).toBe('connecting');
    expect(
      filesEmptyStateReason(session({ id: 's1', status: 'disconnected' })),
    ).toBe('disconnected');
    expect(filesEmptyStateReason(session({ id: 's1', status: 'error' }))).toBe(
      'error',
    );
    expect(
      filesEmptyStateReason(
        session({ id: 's1', status: 'connected', configId: 'cfg-1' }),
      ),
    ).toBe('ready');
  });
});

describe('resolveFilesSessionIds', () => {
  it('returns sessionId and connectionKey when connected', () => {
    expect(
      resolveFilesSessionIds(
        session({ id: 'sess-1', status: 'connected', configId: 'cfg-99' }),
      ),
    ).toEqual({ sessionId: 'sess-1', connectionKey: 'cfg-99' });
  });

  it('allows browsing when connected without configId (no path memory key)', () => {
    expect(
      resolveFilesSessionIds(session({ id: 'sess-1', status: 'connected' })),
    ).toEqual({ sessionId: 'sess-1', connectionKey: null });
  });

  it('returns null when not connected or missing session', () => {
    expect(resolveFilesSessionIds(null)).toBeNull();
    expect(
      resolveFilesSessionIds(
        session({ id: 's1', status: 'disconnected', configId: 'c' }),
      ),
    ).toBeNull();
    expect(
      resolveFilesSessionIds(
        session({ id: 's1', status: 'connecting', configId: 'c' }),
      ),
    ).toBeNull();
  });
});

describe('resolveRememberedPath', () => {
  it('loads path for connectionKey from fileManagerPaths', () => {
    expect(
      resolveRememberedPath(
        'cfg-1',
        { 'cfg-1': '/var/log', 'cfg-2': '/tmp' },
        '/',
      ),
    ).toBe('/var/log');
  });

  it('falls back when key missing or null', () => {
    expect(resolveRememberedPath(null, { 'cfg-1': '/var' }, '/home')).toBe(
      '/home',
    );
    expect(resolveRememberedPath('cfg-x', { 'cfg-1': '/var' }, '/')).toBe('/');
    expect(resolveRememberedPath('cfg-1', undefined, '/opt')).toBe('/opt');
  });

  it('falls back when stored path is empty', () => {
    expect(resolveRememberedPath('cfg-1', { 'cfg-1': '' }, '/')).toBe('/');
    expect(resolveRememberedPath('cfg-1', { 'cfg-1': '   ' }, '/tmp')).toBe(
      '/tmp',
    );
  });
});

describe('transferProgressPercent', () => {
  it('returns 0 when total is 0 or negative', () => {
    expect(transferProgressPercent(10, 0)).toBe(0);
    expect(transferProgressPercent(10, -1)).toBe(0);
  });

  it('clamps between 0 and 100', () => {
    expect(transferProgressPercent(50, 100)).toBe(50);
    expect(transferProgressPercent(0, 100)).toBe(0);
    expect(transferProgressPercent(150, 100)).toBe(100);
    expect(transferProgressPercent(-5, 100)).toBe(0);
  });
});

describe('shouldPersistFileManagerPath', () => {
  it('requires loaded settings, path ready, and connection key', () => {
    expect(
      shouldPersistFileManagerPath({
        settingsLoaded: true,
        pathReady: true,
        connectionKey: 'cfg',
      }),
    ).toBe(true);
    expect(
      shouldPersistFileManagerPath({
        settingsLoaded: false,
        pathReady: true,
        connectionKey: 'cfg',
      }),
    ).toBe(false);
    expect(
      shouldPersistFileManagerPath({
        settingsLoaded: true,
        pathReady: false,
        connectionKey: 'cfg',
      }),
    ).toBe(false);
    expect(
      shouldPersistFileManagerPath({
        settingsLoaded: true,
        pathReady: true,
        connectionKey: null,
      }),
    ).toBe(false);
  });
});

describe('buildFileManagerPathsPatch', () => {
  it('merges without dropping other connection paths', () => {
    expect(
      buildFileManagerPathsPatch({ a: '/a', b: '/b' }, 'b', '/new'),
    ).toEqual({
      a: '/a',
      b: '/new',
    });
    expect(buildFileManagerPathsPatch(undefined, 'x', '/tmp')).toEqual({
      x: '/tmp',
    });
  });
});

describe('isImageFileName', () => {
  it('detects common previewable image extensions case-insensitively', () => {
    expect(isImageFileName('photo.PNG')).toBe(true);
    expect(isImageFileName('a.jpg')).toBe(true);
    expect(isImageFileName('b.JPEG')).toBe(true);
    expect(isImageFileName('c.gif')).toBe(true);
    expect(isImageFileName('d.webp')).toBe(true);
    expect(isImageFileName('e.bmp')).toBe(true);
    expect(isImageFileName('f.ico')).toBe(true);
  });

  it('rejects non-image names', () => {
    expect(isImageFileName('readme.md')).toBe(false);
    expect(isImageFileName('archive.tar.gz')).toBe(false);
    expect(isImageFileName('noext')).toBe(false);
    expect(isImageFileName('photo.tiff')).toBe(false);
  });
});

describe('isProbablyTextFileName', () => {
  it('treats common text/code extensions as text', () => {
    expect(isProbablyTextFileName('app.ts')).toBe(true);
    expect(isProbablyTextFileName('README.md')).toBe(true);
    expect(isProbablyTextFileName('config.json')).toBe(true);
    expect(isProbablyTextFileName('script.sh')).toBe(true);
    expect(isProbablyTextFileName('notes')).toBe(true);
  });

  it('rejects images and known binary extensions', () => {
    expect(isProbablyTextFileName('a.png')).toBe(false);
    expect(isProbablyTextFileName('bin.exe')).toBe(false);
    expect(isProbablyTextFileName('pack.zip')).toBe(false);
    expect(isProbablyTextFileName('a.pdf')).toBe(false);
  });
});

describe('openFileKind', () => {
  it('prefers image over binary for image extensions', () => {
    expect(openFileKind('logo.png')).toBe('image');
  });

  it('returns text for editable names', () => {
    expect(openFileKind('main.rs')).toBe('text');
    expect(openFileKind('Makefile')).toBe('text');
  });

  it('returns binary for non-editable files', () => {
    expect(openFileKind('app.dll')).toBe('binary');
    expect(openFileKind('data.sqlite')).toBe('binary');
  });
});

describe('toggleSelectionName', () => {
  it('adds a missing name and removes an existing one', () => {
    const base = new Set(['a']);
    expect([...toggleSelectionName(base, 'b')].sort()).toEqual(['a', 'b']);
    expect([...toggleSelectionName(base, 'a')]).toEqual([]);
  });

  it('does not mutate the original set', () => {
    const base = new Set(['a']);
    toggleSelectionName(base, 'b');
    expect([...base]).toEqual(['a']);
  });
});

describe('canQuickDelete', () => {
  it('offers quick delete only when targets include a directory', () => {
    expect(canQuickDelete([entry({ name: 'a.txt' })])).toBe(false);
    expect(
      canQuickDelete([entry({ name: 'd', is_dir: true, is_file: false })]),
    ).toBe(true);
    expect(
      canQuickDelete([
        entry({ name: 'a.txt' }),
        entry({ name: 'd', is_dir: true, is_file: false }),
      ]),
    ).toBe(true);
    expect(canQuickDelete([])).toBe(false);
  });
});

describe('batchDeleteProgressText', () => {
  it('formats normal and quick delete progress', () => {
    expect(batchDeleteProgressText(1, 3, false)).toBe('正在删除 1/3…');
    expect(batchDeleteProgressText(2, 5, true)).toBe('正在快速删除 2/5…');
  });
});

describe('defaultArchiveTargetPath', () => {
  it('targets parent dir with basename + format ext (mirrors desktop)', () => {
    expect(defaultArchiveTargetPath('/home/user/foo', 'tar.gz')).toBe(
      '/home/user/foo.tar.gz',
    );
    expect(defaultArchiveTargetPath('/home/user/foo', 'zip')).toBe(
      '/home/user/foo.zip',
    );
  });

  it('handles root-level dirs and trailing slashes', () => {
    expect(defaultArchiveTargetPath('/foo', 'tar.gz')).toBe('/foo.tar.gz');
    expect(defaultArchiveTargetPath('/home/user/foo/', 'zip')).toBe(
      '/home/user/foo.zip',
    );
  });
});

describe('filesListLoadingMode', () => {
  it('returns none when not loading', () => {
    expect(filesListLoadingMode(false, 0)).toBe('none');
    expect(filesListLoadingMode(false, 3)).toBe('none');
  });

  it('uses empty spinner when loading with no entries', () => {
    expect(filesListLoadingMode(true, 0)).toBe('empty');
  });

  it('uses overlay when refreshing with existing entries', () => {
    expect(filesListLoadingMode(true, 5)).toBe('overlay');
  });
});

describe('latestTransferFailure', () => {
  function item(
    id: string,
    patch: Partial<StoredTransferItem> = {},
  ): StoredTransferItem {
    return {
      id,
      kind: 'download',
      sessionId: 's1',
      fileName: `${id}.log`,
      localPath: 'C:/tmp/x',
      remotePath: `/srv/${id}.log`,
      written: 0,
      total: 100,
      statusText: '',
      createdAt: 1,
      status: 'error',
      ...patch,
    };
  }

  it('returns null when no error items', () => {
    const items: Record<string, StoredTransferItem> = {
      a: item('a', { status: 'active' }),
      b: item('b', { status: 'done' }),
    };
    expect(latestTransferFailure(items, ['a', 'b'], 's1')).toBeNull();
  });

  it('returns the most recent error item for the session', () => {
    const items: Record<string, StoredTransferItem> = {
      a: item('a', { status: 'error', statusText: '下载失败：网络' }),
      b: item('b', { status: 'done' }),
      c: item('c', { status: 'error', statusText: '下载失败：写入' }),
    };
    expect(latestTransferFailure(items, ['a', 'b', 'c'], 's1')).toEqual({
      id: 'c',
      fileName: 'c.log',
      statusText: '下载失败：写入',
    });
  });

  it('ignores sysopen tasks (driven by backend state events)', () => {
    const items: Record<string, StoredTransferItem> = {
      a: item('sysopen-dl-t1', { status: 'error', statusText: '下载失败' }),
      b: item('b', { status: 'error', statusText: '下载失败：写入' }),
    };
    expect(latestTransferFailure(items, ['sysopen-dl-t1', 'b'], 's1')).toEqual({
      id: 'b',
      fileName: 'b.log',
      statusText: '下载失败：写入',
    });
  });

  it('ignores error items from other sessions', () => {
    const items: Record<string, StoredTransferItem> = {
      a: item('a', { sessionId: 's2', status: 'error', statusText: 'X' }),
    };
    expect(latestTransferFailure(items, ['a'], 's1')).toBeNull();
  });
});
