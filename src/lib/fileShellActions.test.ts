// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

const sshSendInput = vi.fn(async () => {});
vi.mock('@/lib/tauri', () => ({ sshSendInput: (...a: unknown[]) => sshSendInput(...(a as [])) }));

import {
  cdCommand,
  sendCdToTerminal,
  shellQuote,
} from './fileShellActions';

describe('shell 转义', () => {
  it('普通路径加单引号', () => {
    expect(shellQuote('/srv/app')).toBe("'/srv/app'");
  });

  it('单引号按 POSIX 规则转义', () => {
    expect(shellQuote("/tmp/it's")).toBe(`'/tmp/it'\\''s'`);
  });

  it('空格、美元符、反引号都留在引号内，不会被 shell 展开', () => {
    expect(cdCommand('/a b/$HOME/`x`')).toBe("cd '/a b/$HOME/`x`'\r");
  });

  it('sendCdToTerminal 发整行命令（含回车）', async () => {
    await sendCdToTerminal('s1', "/data/o'neil");
    expect(sshSendInput).toHaveBeenCalledWith('s1', `cd '/data/o'\\''neil'\r`);
  });
});
