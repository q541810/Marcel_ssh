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

describe('命令说明（bash 的必填 description）', () => {
  it('提取成单独的字段，并从 extras 里剔除（否则同一句话显示两遍）', () => {
    const result = cleanExecuteCommandArgs({
      command: 'systemctl restart nginx',
      description: '重启 nginx 以加载新配置',
    });
    expect(result.description).toBe('重启 nginx 以加载新配置');
    expect(result.extras).toEqual({});
    expect(JSON.stringify(result.extras)).not.toContain('重启 nginx');
  });

  it('说明与其他额外参数并存时，两者各归各位', () => {
    const result = cleanExecuteCommandArgs({
      command: 'ls -la',
      description: '查看当前目录内容',
      host: 'web-prod-01',
    });
    expect(result.description).toBe('查看当前目录内容');
    expect(result.extras).toEqual({ host: 'web-prod-01' });
  });

  it('没有说明（旧会话、其他命令类工具）时字段为空，不虚构', () => {
    expect(cleanExecuteCommandArgs({ command: 'ls' }).description).toBeUndefined();
    expect(cleanExecuteCommandArgs({}).description).toBeUndefined();
    expect(cleanExecuteCommandArgs(undefined).description).toBeUndefined();
  });

  it('空白说明等同于没有，不渲染一行空白', () => {
    expect(
      cleanExecuteCommandArgs({ command: 'ls', description: '' }).description,
    ).toBeUndefined();
    expect(
      cleanExecuteCommandArgs({ command: 'ls', description: '   ' }).description,
    ).toBeUndefined();
  });

  it('说明不是字符串时也不崩（模型可能给错类型）', () => {
    const result = cleanExecuteCommandArgs({ command: 'ls', description: 42 });
    expect(result.description).toBeUndefined();
    // 类型不对的值照旧作为额外参数原样保留，不静默丢弃信息
    expect(result.extras).toEqual({ description: 42 });
  });
});
