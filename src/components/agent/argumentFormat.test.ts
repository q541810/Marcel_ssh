import { describe, expect, it } from 'vitest';
import {
  cleanExecuteCommandArgs,
  isUselessValue,
  type CleanedArguments,
} from './argumentFormat';

describe('isUselessValue', () => {
  it('treats null/undefined/empty string as useless', () => {
    expect(isUselessValue(null)).toBe(true);
    expect(isUselessValue(undefined)).toBe(true);
    expect(isUselessValue('')).toBe(true);
    expect(isUselessValue('   ')).toBe(true);
  });

  it('treats empty array/object as useless', () => {
    expect(isUselessValue([])).toBe(true);
    expect(isUselessValue({})).toBe(true);
  });

  it('keeps meaningful values', () => {
    expect(isUselessValue('ls -la')).toBe(false);
    expect(isUselessValue(0)).toBe(false);
    expect(isUselessValue(false)).toBe(false);
    expect(isUselessValue(['a'])).toBe(false);
    expect(isUselessValue({ a: 1 })).toBe(false);
  });
});

describe('cleanExecuteCommandArgs', () => {
  it('extracts command as main and drops timeout_secs', () => {
    const result = cleanExecuteCommandArgs({
      command: 'npm run build',
      timeout_secs: 120,
    });
    expect(result.main).toBe('npm run build');
    expect(result.extras).toEqual({});
  });

  it('keeps unknown extra fields, dropping empty ones', () => {
    const result = cleanExecuteCommandArgs({
      command: 'ls -la',
      cwd: '/tmp',
      note: '',
      env: {},
    });
    expect(result.main).toBe('ls -la');
    expect(result.extras).toEqual({ cwd: '/tmp' });
  });

  it('handles missing/empty command', () => {
    const result: CleanedArguments = cleanExecuteCommandArgs({});
    expect(result.main).toBeUndefined();
    expect(result.extras).toEqual({});

    const noArgs: CleanedArguments = cleanExecuteCommandArgs(undefined);
    expect(noArgs.main).toBeUndefined();
    expect(noArgs.extras).toEqual({});

    const blank: CleanedArguments = cleanExecuteCommandArgs({ command: '  ' });
    expect(blank.main).toBeUndefined();
    expect(blank.extras).toEqual({});
  });
});
