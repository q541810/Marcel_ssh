import { describe, expect, it } from 'vitest';
import {
  ancestorPaths,
  buildVisibleRows,
  navigateTreeKey,
  cacheKeysUnder,
  canExpandPath,
  canWalkChildren,
  chainChildToward,
  clampTreeWidth,
  FILE_TREE_MAX_DEPTH,
  filterDirEntries,
  invalidateCacheAt,
  isCacheFresh,
  joinRemotePath,
  normalizeRemotePath,
  pathDepth,
  seedCacheFromListing,
  type TreeCache,
} from './fileTreeModel';

describe('fileTreeModel', () => {
  it('normalizes remote paths', () => {
    expect(normalizeRemotePath('')).toBe('/');
    expect(normalizeRemotePath('/')).toBe('/');
    expect(normalizeRemotePath('/home/user/')).toBe('/home/user');
    expect(normalizeRemotePath('//home//user')).toBe('/home/user');
  });

  it('joins remote paths', () => {
    expect(joinRemotePath('/', 'etc')).toBe('/etc');
    expect(joinRemotePath('/home', 'user')).toBe('/home/user');
    expect(joinRemotePath('/home/', 'user')).toBe('/home/user');
  });

  it('builds ancestor chain including self', () => {
    expect(ancestorPaths('/')).toEqual(['/']);
    expect(ancestorPaths('/home/user/docs')).toEqual(['/', '/home', '/home/user', '/home/user/docs']);
  });

  it('clamps tree width', () => {
    expect(clampTreeWidth(50)).toBe(140);
    expect(clampTreeWidth(200)).toBe(200);
    expect(clampTreeWidth(999)).toBe(360);
  });

  it('filters directory entries and respects hidden flag', () => {
    const entries = [
      { name: '.', is_dir: true, is_symlink: false },
      { name: 'visible', is_dir: true, is_symlink: false },
      { name: '.secret', is_dir: true, is_symlink: false },
      { name: 'file.txt', is_dir: false, is_symlink: false },
      { name: 'link', is_dir: true, is_symlink: true },
    ];
    expect(filterDirEntries(entries, '/home', false).map((d) => d.name)).toEqual(['link', 'visible']);
    expect(filterDirEntries(entries, '/home', true).map((d) => d.name)).toEqual(['.secret', 'link', 'visible']);
    expect(filterDirEntries(entries, '/home', true).find((d) => d.name === 'link')?.path).toBe('/home/link');
  });

  it('enforces max depth for expand safety', () => {
    const deep = `/${Array.from({ length: FILE_TREE_MAX_DEPTH }, (_, i) => `d${i}`).join('/')}`;
    expect(pathDepth(deep)).toBe(FILE_TREE_MAX_DEPTH);
    expect(canExpandPath(deep)).toBe(false);
    expect(canExpandPath('/a/b')).toBe(true);
  });

  it('lists cache keys under a path', () => {
    const cache: TreeCache = {
      '/': { status: 'loaded', dirs: [] },
      '/home': { status: 'loaded', dirs: [] },
      '/home/user': { status: 'loaded', dirs: [] },
      '/etc': { status: 'loaded', dirs: [] },
    };
    expect(cacheKeysUnder(cache, '/home').sort()).toEqual(['/home', '/home/user']);
    expect(cacheKeysUnder(cache, '/').sort()).toEqual(['/', '/etc', '/home', '/home/user']);
  });

  it('isCacheFresh treats loaded and loading as hit', () => {
    expect(isCacheFresh(undefined)).toBe(false);
    expect(isCacheFresh({ status: 'idle', dirs: [] })).toBe(false);
    expect(isCacheFresh({ status: 'error', dirs: [] })).toBe(false);
    expect(isCacheFresh({ status: 'loading', dirs: [] })).toBe(true);
    expect(isCacheFresh({ status: 'loaded', dirs: [] })).toBe(true);
  });

  it('seedCacheFromListing marks path loaded with dir children only', () => {
    const empty: TreeCache = {};
    const seeded = seedCacheFromListing(
      empty,
      '/home',
      [
        { name: 'docs', is_dir: true, is_symlink: false },
        { name: 'readme', is_dir: false, is_symlink: false },
        { name: '.cache', is_dir: true, is_symlink: false },
      ],
      false,
    );
    expect(seeded['/home']?.status).toBe('loaded');
    expect(seeded['/home']?.dirs.map((d) => d.name)).toEqual(['docs']);
    // After seed, expand must treat as fresh (no network).
    expect(isCacheFresh(seeded['/home'])).toBe(true);
  });

  it('seed respects showHidden and overwrites previous entry', () => {
    const prev: TreeCache = {
      '/home': { status: 'loading', dirs: [{ name: 'old', path: '/home/old', isSymlink: false }] },
    };
    const next = seedCacheFromListing(
      prev,
      '/home',
      [
        { name: '.hidden', is_dir: true, is_symlink: false },
        { name: 'new', is_dir: true, is_symlink: false },
      ],
      true,
    );
    expect(next['/home']?.status).toBe('loaded');
    expect(next['/home']?.dirs.map((d) => d.name)).toEqual(['.hidden', 'new']);
  });

  it('invalidateCacheAt drops self and descendants only', () => {
    const cache: TreeCache = {
      '/': { status: 'loaded', dirs: [] },
      '/home': { status: 'loaded', dirs: [] },
      '/home/user': { status: 'loaded', dirs: [] },
      '/etc': { status: 'loaded', dirs: [] },
    };
    const next = invalidateCacheAt(cache, '/home');
    expect(Object.keys(next).sort()).toEqual(['/', '/etc']);
  });

  it('canWalkChildren keeps SWR stale dirs visible while loading', () => {
    expect(canWalkChildren(undefined)).toBe(false);
    expect(canWalkChildren({ status: 'loading', dirs: [] })).toBe(false);
    expect(
      canWalkChildren({
        status: 'loading',
        dirs: [{ name: 'a', path: '/a', isSymlink: false }],
      }),
    ).toBe(true);
    expect(canWalkChildren({ status: 'loaded', dirs: [] })).toBe(true);
  });

  it('chainChildToward：列不出来的祖先补上通往当前目录的下一级', () => {
    expect(chainChildToward('/', '/usr/home/u')).toEqual({
      name: 'usr',
      path: '/usr',
      isSymlink: false,
    });
    expect(chainChildToward('/usr', '/usr/home/u')?.path).toBe('/usr/home');
    expect(chainChildToward('/usr/home', '/usr/home/u/')?.path).toBe('/usr/home/u');
  });

  it('chainChildToward：不是真祖先（自己、兄弟、前缀同名）一律不补', () => {
    expect(chainChildToward('/usr/home/u', '/usr/home/u')).toBeNull();
    expect(chainChildToward('/var', '/usr/home/u')).toBeNull();
    expect(chainChildToward('/usr/ho', '/usr/home/u')).toBeNull();
    expect(chainChildToward('/', '/')).toBeNull();
  });
});

describe('buildVisibleRows / navigateTreeKey', () => {
  const cache: TreeCache = {
    '/': {
      status: 'loaded',
      dirs: [
        { name: 'a', path: '/a', isSymlink: false },
        { name: 'b', path: '/b', isSymlink: false },
      ],
    },
    '/a': { status: 'loaded', dirs: [{ name: 'x', path: '/a/x', isSymlink: false }] },
  };
  const expandable = () => true;
  const hasKids = () => true;

  it('只展开已展开且已加载的节点；主目录快捷项置顶', () => {
    const rows = buildVisibleRows(cache, new Set(['/', '/a']), '/home/u');
    expect(rows.map((r) => r.key)).toEqual(['home:/home/u', '/', '/a', '/a/x', '/b']);
    expect(buildVisibleRows(cache, new Set(['/'])).map((r) => r.path)).toEqual(['/', '/a', '/b']);
    expect(buildVisibleRows(cache, new Set(['/']), '/').map((r) => r.key)).toEqual(['/', '/a', '/b']);
  });

  it('方向键：上下边界夹取，Home/End', () => {
    const rows = buildVisibleRows(cache, new Set(['/']));
    const open = new Set(['/']);
    expect(navigateTreeKey(rows, 0, 'ArrowUp', open, expandable, hasKids).index).toBe(0);
    expect(navigateTreeKey(rows, 2, 'ArrowDown', open, expandable, hasKids).index).toBe(2);
    expect(navigateTreeKey(rows, 1, 'End', open, expandable, hasKids).index).toBe(2);
    expect(navigateTreeKey(rows, 2, 'Home', open, expandable, hasKids).index).toBe(0);
  });

  it('右键/左键的展开、进子、回父语义', () => {
    const open = new Set(['/', '/a']);
    const rows = buildVisibleRows(cache, open);
    // /b 未展开 → 展开
    expect(navigateTreeKey(rows, 3, 'ArrowRight', open, expandable, hasKids)).toEqual({
      index: 3,
      toggle: '/b',
    });
    // /a 已展开 → 进第一个子节点
    expect(navigateTreeKey(rows, 1, 'ArrowRight', open, expandable, hasKids).index).toBe(2);
    // /a/x 是叶子，左 → 父 /a
    expect(navigateTreeKey(rows, 2, 'ArrowLeft', open, expandable, () => false).index).toBe(1);
    // /a 已展开，左 → 收起
    expect(navigateTreeKey(rows, 1, 'ArrowLeft', open, expandable, hasKids).toggle).toBe('/a');
    // 没有子目录的节点按右不动
    expect(navigateTreeKey(rows, 3, 'ArrowRight', open, expandable, () => false)).toEqual({ index: 3 });
  });
});
