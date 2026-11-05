import { describe, expect, it } from 'vitest';
import {
  defaultFileAction,
  fileLinkActionItems,
  findConnectionByHost,
  parseFileLink,
  relativeCandidates,
  relativePathUnder,
  resolveFileMachine,
  toolFileRefs,
  type MachineContext,
} from './fileLink';
import { decideOpen } from './sftpFileOpen';

describe('parseFileLink', () => {
  it('parses remote paths and ignores other schemes', () => {
    expect(parseFileLink('remote:/data/out.csv')).toEqual({ side: 'remote', host: null, path: '/data/out.csv', isDir: undefined });
    expect(parseFileLink('https://x.com/a')).toBeNull();
    expect(parseFileLink('remote:relative/path')).toBeNull();
    expect(parseFileLink('remote://hostonly')).toBeNull();
    expect(parseFileLink(undefined)).toBeNull();
  });

  it('decodes percent-encoded paths (spaces, CJK) as emitted by the markdown library', () => {
    expect(parseFileLink('remote:/data/%E6%8A%A5%E5%91%8A%20v2.md')?.path).toBe('/data/报告 v2.md');
    expect(parseFileLink('remote:/a/100%/x')?.path).toBe('/a/100%/x');
  });

  it('takes the host from remote://<id>/ including :n suffix and encoded names', () => {
    expect(parseFileLink('remote://web-1/var/log/a.log')).toMatchObject({ host: 'web-1', path: '/var/log/a.log' });
    expect(parseFileLink('remote://web-1:2/etc/hosts')).toMatchObject({ host: 'web-1:2', path: '/etc/hosts' });
    expect(parseFileLink('remote://%E6%B5%8B%E8%AF%95%20%E6%9C%BA/tmp/x')).toMatchObject({ host: '测试 机', path: '/tmp/x' });
    expect(parseFileLink('remote:///tmp/x')).toMatchObject({ host: null, path: '/tmp/x' });
  });

  it('marks trailing slash as directory and trims it', () => {
    expect(parseFileLink('remote:/srv/app/')).toMatchObject({ path: '/srv/app', isDir: true });
    expect(parseFileLink('remote:/')).toMatchObject({ path: '/' });
  });

  it('parses local windows and posix paths', () => {
    expect(parseFileLink('local:C:/Users/me/a.txt')).toMatchObject({ side: 'local', path: 'C:/Users/me/a.txt' });
    expect(parseFileLink('local:/C:/Users/me/a.txt')?.path).toBe('C:/Users/me/a.txt');
    expect(parseFileLink('local:/home/me/a.txt')?.path).toBe('/home/me/a.txt');
    expect(parseFileLink('local:C:/Users/%E6%88%91/a%20b.txt')?.path).toBe('C:/Users/我/a b.txt');
    expect(parseFileLink('local:relative.txt')).toBeNull();
  });
});

describe('relativePathUnder', () => {
  it('returns the part below the base', () => {
    expect(relativePathUnder('/srv/app/src/a.ts', '/srv/app')).toBe('src/a.ts');
    expect(relativePathUnder('/srv/app/src/a.ts', '/srv/app/')).toBe('src/a.ts');
    expect(relativePathUnder('/a', '/')).toBe('a');
  });
  it('is null when equal to the base or outside it', () => {
    expect(relativePathUnder('/srv/app', '/srv/app')).toBeNull();
    expect(relativePathUnder('/srv/app/', '/srv/app')).toBeNull();
    expect(relativePathUnder('/srv/application/a', '/srv/app')).toBeNull();
    expect(relativePathUnder('/etc/hosts', '/srv/app')).toBeNull();
    expect(relativePathUnder('/a', null)).toBeNull();
  });
  it('writes ~/… for the home form', () => {
    expect(relativePathUnder('/home/u/a/b', '/home/u', { tilde: true })).toBe('~/a/b');
    expect(relativePathUnder('/home/u', '/home/u', { tilde: true })).toBeNull();
    expect(relativePathUnder('/a', '/', { tilde: true })).toBeNull();
  });
  it('handles windows separators and drive case', () => {
    expect(relativePathUnder('C:/proj/src/a.ts', 'c:\\proj')).toBe('src/a.ts');
  });
});

describe('relativeCandidates', () => {
  const bases = [
    { id: 'fileManager' as const, dir: '/home/u/proj/src' },
    { id: 'project' as const, dir: '/home/u/proj' },
    { id: 'home' as const, dir: '/home/u' },
  ];
  it('lists every base the path is under, nearest first, with the copied text', () => {
    expect(relativeCandidates('/home/u/proj/src/a.ts', bases)).toEqual([
      { id: 'fileManager', label: '相对文件管理当前目录', text: 'a.ts' },
      { id: 'project', label: '相对项目根目录', text: 'src/a.ts' },
      { id: 'home', label: '相对家目录', text: '~/proj/src/a.ts' },
    ]);
  });
  it('skips bases the path is not under or equals', () => {
    expect(relativeCandidates('/home/u/proj', bases).map((c) => c.id)).toEqual(['home']);
    expect(relativeCandidates('/etc/hosts', bases)).toEqual([]);
  });
});

describe('actions', () => {
  it('offers open for text and images only, never a second name for the same action', () => {
    const ids = (path: string, isDir = false) =>
      fileLinkActionItems({ side: 'remote', path, isDir }).map((i) => i.id);
    expect(ids('/a/b.md')).toContain('open');
    expect(ids('/a/b.png')).toContain('open');
    for (const path of ['/a/b.md', '/a/b.png', '/a/b.zip']) {
      expect(ids(path)).not.toContain('editor');
      expect(ids(path)).not.toContain('preview');
    }
    expect(ids('/a/b.zip')).not.toContain('open');
    expect(ids('/a', true)).not.toContain('open');
  });
  it('keeps the first level short and puts terminal / relative paths below a divider', () => {
    const ids = (path: string, opts = {}, isDir = false) =>
      fileLinkActionItems({ side: 'remote', path, isDir }, opts).map((i) => i.id);
    const relative = [{ id: 'home' as const, label: '相对家目录', text: '~/b.md' }];
    expect(ids('/a/b.md', { relative })).toEqual([
      'open', 'reveal', 'copyPath', 'divider', 'cd', 'copyRelative',
    ]);
    expect(ids('/a/b.png')).toEqual(['open', 'reveal', 'copyPath', 'divider', 'cd']);
    // 二进制 / 目录的「打开」就是在文件管理中显示，不重复列
    expect(ids('/a/b.zip')).toEqual(['reveal', 'copyPath', 'divider', 'cd']);
    expect(ids('/a', {}, true)).toEqual(['reveal', 'copyPath', 'divider', 'cd']);
  });
  it('hides every file-manager item when the bottom panel has nowhere to show it', () => {
    const ids = fileLinkActionItems({ side: 'remote', path: '/a/b.md' }, { fileManager: false }).map((i) => i.id);
    expect(ids).toEqual(['copyPath', 'divider', 'cd']);
  });
  it('local files only get reveal and copy; unresolved machines only copy', () => {
    expect(fileLinkActionItems({ side: 'local', path: 'C:/a.txt' }).map((i) => i.id)).toEqual(['reveal', 'copyPath']);
    expect(fileLinkActionItems({ side: 'remote', path: '/a.txt' }, { unresolved: true }).map((i) => i.id)).toEqual(['copyPath']);
  });
  it('shows the exact copied text as hints and a relative submenu only when there are candidates', () => {
    const items = fileLinkActionItems(
      { side: 'remote', path: '/a/b.md' },
      { relative: [{ id: 'home', label: '相对家目录', text: '~/b.md' }] },
    );
    expect(items.find((i) => i.id === 'copyPath')?.hint).toBe('/a/b.md');
    expect(items.find((i) => i.id === 'copyRelative')?.children?.[0].text).toBe('~/b.md');
    expect(fileLinkActionItems({ side: 'remote', path: '/a/b.md' }).some((i) => i.id === 'copyRelative')).toBe(false);
  });
  it('default action opens text/images and reveals everything else', () => {
    expect(defaultFileAction({ side: 'remote', path: '/a.md' })).toBe('open');
    expect(defaultFileAction({ side: 'remote', path: '/a.zip' })).toBe('reveal');
    expect(defaultFileAction({ side: 'remote', path: '/a', isDir: true })).toBe('reveal');
    expect(defaultFileAction({ side: 'local', path: 'C:/a.md' })).toBe('reveal');
  });
});

describe('toolFileRefs', () => {
  it('reads path and host structurally, local tools are local', () => {
    expect(toolFileRefs('write_file', { path: '/a/b.md', host: 'web' })).toEqual([
      { side: 'remote', host: 'web', path: '/a/b.md', isDir: undefined },
    ]);
    expect(toolFileRefs('local_edit_file', { path: 'C:/x.ts' })[0]).toMatchObject({ side: 'local', host: null });
    expect(toolFileRefs('upload_file', { remote_path: '/srv/', local_path: 'C:/x.zip' }).map((r) => r.side)).toEqual(['remote', 'local']);
    expect(toolFileRefs('bash', { path: '/a' })).toEqual([]);
    expect(toolFileRefs('write_file', { path: 'relative' })).toEqual([]);
  });
});

describe('resolveFileMachine', () => {
  const sessions: MachineContext['sessions'] = {
    s1: { id: 's1', status: 'connected', configId: 'c1', createdAt: '2026-01-01' },
    s2: { id: 's2', status: 'connected', configId: 'c2', createdAt: '2026-01-02' },
    s3: { id: 's3', status: 'disconnected', configId: 'c3', createdAt: '2026-01-03' },
  };
  const connections = [
    { id: 'c1', name: 'web' },
    { id: 'c2', name: 'web' },
    { id: 'c3', name: 'db' },
  ];
  const ctx = (bound: string | null): MachineContext => ({ boundSessionId: bound, sessions, connections });

  it('uses the bound session when no host is given', () => {
    expect(resolveFileMachine({ side: 'remote', host: null }, ctx('s1'))).toMatchObject({ ok: true, sessionId: 's1' });
    expect(resolveFileMachine({ side: 'remote', host: null }, ctx(null))).toMatchObject({ ok: false });
    expect(resolveFileMachine({ side: 'remote', host: null }, ctx('s3'))).toMatchObject({ ok: false });
  });
  it('matches host by name with :n disambiguation, and never falls back to another machine', () => {
    expect(findConnectionByHost(connections, 'web')?.id).toBe('c1');
    expect(findConnectionByHost(connections, 'web:1')?.id).toBe('c2');
    expect(resolveFileMachine({ side: 'remote', host: 'web:1' }, ctx('s1'))).toMatchObject({ ok: true, sessionId: 's2' });
    expect(resolveFileMachine({ side: 'remote', host: 'db' }, ctx('s1'))).toMatchObject({ ok: false });
    expect(resolveFileMachine({ side: 'remote', host: 'nope' }, ctx('s1'))).toMatchObject({ ok: false });
  });
  it('local paths need the desktop', () => {
    expect(resolveFileMachine({ side: 'local', host: null }, ctx(null))).toMatchObject({ ok: true, sessionId: null });
    expect(resolveFileMachine({ side: 'local', host: null }, { ...ctx(null), mobile: true })).toMatchObject({ ok: false });
  });
});

describe('decideOpen', () => {
  it('previews images, edits text, refuses binaries and oversized files', () => {
    expect(decideOpen('a.png', 10)).toEqual({ kind: 'preview' });
    expect(decideOpen('a.md', 10)).toEqual({ kind: 'editor' });
    expect(decideOpen('a.zip', 10).kind).toBe('refuse');
    expect(decideOpen('a.md', 1e9).kind).toBe('refuse');
    expect(decideOpen('a.md', 10, 'preview').kind).toBe('refuse');
    expect(decideOpen('a.png', 10, 'editor').kind).toBe('refuse');
  });
});
