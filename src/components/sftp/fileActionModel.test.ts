import { describe, expect, it } from 'vitest';
import {
  baseName,
  isSameOrUnder,
  parentDir,
  targetFromEntry,
  targetFromTreePath,
  terminalDirOf,
} from './fileActionModel';

describe('fileActionModel 路径构造', () => {
  it('parentDir / baseName', () => {
    expect(parentDir('/')).toBe('/');
    expect(parentDir('/etc')).toBe('/');
    expect(parentDir('/home/user/')).toBe('/home');
    expect(baseName('/home/user')).toBe('user');
    expect(baseName('/')).toBe('/');
  });

  it('列表条目 → 绝对路径目标（根目录与深层目录）', () => {
    const entry = { name: 'a b.txt', is_dir: false, is_file: true, is_symlink: false, size: 3, mode: 0 };
    expect(targetFromEntry('/', entry)).toEqual({
      path: '/a b.txt',
      name: 'a b.txt',
      isDir: false,
      size: 3,
    });
    expect(targetFromEntry('/var/log', entry).path).toBe('/var/log/a b.txt');
  });

  it('树节点 → 目录目标', () => {
    expect(targetFromTreePath('/home/u/')).toEqual({ path: '/home/u', name: 'u', isDir: true });
  });

  it('isSameOrUnder 区分前缀同名的兄弟目录', () => {
    expect(isSameOrUnder('/a/b', '/a/b')).toBe(true);
    expect(isSameOrUnder('/a/b/c', '/a/b')).toBe(true);
    expect(isSameOrUnder('/a/bc', '/a/b')).toBe(false);
    expect(isSameOrUnder('/a', '/')).toBe(true);
  });

  it('terminalDirOf：目录进自己，文件进所在目录', () => {
    expect(terminalDirOf({ path: '/srv/app', isDir: true })).toBe('/srv/app');
    expect(terminalDirOf({ path: '/srv/app/run.sh', isDir: false })).toBe('/srv/app');
    expect(terminalDirOf({ path: '/run.sh', isDir: false })).toBe('/');
  });
});
