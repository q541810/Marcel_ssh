import { describe, it, expect } from 'vitest';
import type { SftpFileEntry } from '@/lib/types';
import {
  sortFileEntries,
  joinRemotePath,
  isImageFileName,
  isProbablyTextFileName,
  openFileKind,
  binaryNotEditableMessage,
  imageTooLargeMessage,
  fileTooLargeMessage,
  defaultArchiveTargetPath,
} from './sftpFileOpen';

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
  it('puts directories first then sorts by name case-insensitively / numerically', () => {
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

  it('sorts numeric names by value (numeric: true)', () => {
    const input = [
      entry({ name: 'log10.txt' }),
      entry({ name: 'log2.txt' }),
      entry({ name: 'log1.txt' }),
    ];
    expect(sortFileEntries(input).map((e) => e.name)).toEqual([
      'log1.txt',
      'log2.txt',
      'log10.txt',
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

  it('strips trailing slash on parent (path bar edit can submit one)', () => {
    expect(joinRemotePath('/home/', 'user')).toBe('/home/user');
    expect(joinRemotePath('/var/log///', 'app.log')).toBe('/var/log/app.log');
  });

  it('treats empty parent as root', () => {
    expect(joinRemotePath('', 'x')).toBe('/x');
  });
});

describe('openFileKind (and its predicates)', () => {
  it('prefers image over binary for image extensions', () => {
    expect(openFileKind('logo.png')).toBe('image');
    expect(isImageFileName('photo.PNG')).toBe(true);
  });

  it('returns text for editable names including extensionless files', () => {
    expect(openFileKind('main.rs')).toBe('text');
    expect(openFileKind('Makefile')).toBe('text');
    expect(isProbablyTextFileName('notes')).toBe(true);
  });

  it('returns binary for non-editable files', () => {
    expect(openFileKind('app.dll')).toBe('binary');
    expect(openFileKind('data.sqlite')).toBe('binary');
  });
});

describe('拒绝打开的统一文案', () => {
  it('binary message carries the lowercased dotted extension', () => {
    expect(binaryNotEditableMessage('app.dll')).toBe(
      '无法编辑二进制文件 (.dll)，请使用下载功能',
    );
    expect(binaryNotEditableMessage('APP.DLL')).toBe(
      '无法编辑二进制文件 (.dll)，请使用下载功能',
    );
  });

  it('binary message degrades to empty parens without extension', () => {
    expect(binaryNotEditableMessage('noext')).toBe(
      '无法编辑二进制文件 ()，请使用下载功能',
    );
  });

  it('size messages share formatSize wording with both platforms', () => {
    expect(imageTooLargeMessage(60 * 1024 * 1024)).toBe(
      '图片过大 (60.0 MB)，预览上限为 50.0 MB，请使用下载功能',
    );
    expect(fileTooLargeMessage(3 * 1024 * 1024)).toBe(
      '文件过大 (3.0 MB)，编辑器限制为 2.0 MB，请使用下载功能',
    );
  });
});

describe('defaultArchiveTargetPath', () => {
  it('targets parent dir with basename + format ext', () => {
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
