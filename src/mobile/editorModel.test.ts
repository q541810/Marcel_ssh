import { describe, it, expect } from 'vitest';
import { decideSaveAction, isFileMissingMessage } from './editorModel';

describe('decideSaveAction', () => {
  it('saves when remote mtime matches the one we loaded', () => {
    expect(decideSaveAction(1000, 1000)).toBe('save');
  });

  it('asks for overwrite confirmation when remote file changed', () => {
    expect(decideSaveAction(2000, 1000)).toBe('conflict');
  });

  it('saves when remote mtime could not be fetched (non-fatal)', () => {
    expect(decideSaveAction(null, 1000)).toBe('save');
  });
});

describe('isFileMissingMessage', () => {
  it('detects common not-found error texts', () => {
    expect(isFileMissingMessage('No such file or directory')).toBe(true);
    expect(isFileMissingMessage('路径不存在')).toBe(true);
    expect(isFileMissingMessage('file not found')).toBe(true);
  });

  it('rejects unrelated errors', () => {
    expect(isFileMissingMessage('Permission denied')).toBe(false);
    expect(isFileMissingMessage('')).toBe(false);
  });
});
