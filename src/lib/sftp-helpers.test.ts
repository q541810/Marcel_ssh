import { describe, it, expect } from 'vitest';
import { formatSize, modeToString, getErrorMessage } from '@/lib/sftp-helpers';

describe('formatSize', () => {
  it('returns dash for zero bytes', () => {
    expect(formatSize(0)).toBe('-');
  });

  it('formats bytes', () => {
    expect(formatSize(512)).toBe('512 B');
  });

  it('formats kilobytes', () => {
    expect(formatSize(2048)).toBe('2.0 KB');
  });

  it('formats megabytes', () => {
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('formats gigabytes', () => {
    expect(formatSize(3.5 * 1024 * 1024 * 1024)).toBe('3.5 GB');
  });

  it('handles one-byte boundary values', () => {
    expect(formatSize(1)).toBe('1 B');
    expect(formatSize(1023)).toBe('1023 B');
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(1024 * 1024)).toBe('1.0 MB');
  });
});

describe('modeToString', () => {
  it('formats directory permissions', () => {
    expect(modeToString(0o040755)).toBe('drwxr-xr-x');
  });

  it('formats regular file permissions', () => {
    expect(modeToString(0o100644)).toBe('-rw-r--r--');
  });

  it('formats symbolic link permissions', () => {
    expect(modeToString(0o120777)).toBe('lrwxrwxrwx');
  });

  it('formats all permissions', () => {
    expect(modeToString(0o100777)).toBe('-rwxrwxrwx');
  });

  it('formats no permissions', () => {
    expect(modeToString(0o100000)).toBe('----------');
  });

  it('formats odd permission sets', () => {
    expect(modeToString(0o100640)).toBe('-rw-r-----');
    expect(modeToString(0o100600)).toBe('-rw-------');
    expect(modeToString(0o040700)).toBe('drwx------');
  });
});

describe('getErrorMessage', () => {
  it('returns string directly', () => {
    expect(getErrorMessage('connection failed')).toBe('connection failed');
  });

  it('returns message field from object', () => {
    expect(getErrorMessage({ message: 'timeout' })).toBe('timeout');
  });

  it('appends hint for SFTP code 2 (no such file)', () => {
    const err = { message: 'open failed', code: 2 };
    expect(getErrorMessage(err)).toContain('open failed');
    expect(getErrorMessage(err)).toContain('文件或目录不存在');
  });

  it('appends hint for SFTP code 3 (permission denied)', () => {
    const err = { message: 'access denied', code: 3 };
    expect(getErrorMessage(err)).toContain('权限不足');
  });

  it('appends hint for SFTP code 4 (operation failed)', () => {
    const err = { message: 'op failed', code: 4 };
    expect(getErrorMessage(err)).toContain('操作失败');
  });

  it('appends hint for SFTP code 5 (bad file handle)', () => {
    const err = { message: 'bad handle', code: 5 };
    expect(getErrorMessage(err)).toContain('错误的文件句柄');
  });

  it('returns raw message for unknown SFTP code', () => {
    const err = { message: 'unknown error', code: 99 };
    expect(getErrorMessage(err)).toBe('unknown error');
  });

  it('falls back to JSON.stringify for non-standard objects', () => {
    expect(getErrorMessage({ code: 42 })).toBe('{"code":42}');
  });

  it('returns fallback for unserializable objects', () => {
    const circular: Record<string, unknown> = {};
    (circular as Record<string, unknown>).self = circular;
    expect(getErrorMessage(circular)).toBe('未知错误');
  });
});
