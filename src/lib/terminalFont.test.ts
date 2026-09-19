import { describe, expect, it, vi } from 'vitest';
import {
  BUNDLED_NERD_FONT_FAMILY,
  buildTerminalFontFamily,
  ensureBundledNerdFontLoaded,
  isBundledNerdFontFamily,
  onBundledNerdFontReady,
  parseFontFamilies,
} from '@/lib/terminalFont';

const BUILTIN = `"${BUNDLED_NERD_FONT_FAMILY}"`;

describe('parseFontFamilies', () => {
  it('按逗号切分并去掉首尾空白', () => {
    expect(parseFontFamilies('  A , B ,C  ')).toEqual(['A', 'B', 'C']);
  });

  it('引号内的逗号不是分隔符', () => {
    expect(parseFontFamilies('"Foo, Bar", monospace')).toEqual(['"Foo, Bar"', 'monospace']);
  });

  it('丢弃空 token（连续逗号 / 结尾逗号 / 全空）', () => {
    expect(parseFontFamilies('A,,B,')).toEqual(['A', 'B']);
    expect(parseFontFamilies('   ')).toEqual([]);
  });

  it('按大小写不敏感去重，保留首个写法', () => {
    expect(parseFontFamilies('Menlo, menlo, MENLO')).toEqual(['Menlo']);
  });
});

describe('isBundledNerdFontFamily', () => {
  it('忽略引号与大小写', () => {
    expect(isBundledNerdFontFamily(BUILTIN)).toBe(true);
    expect(isBundledNerdFontFamily(BUNDLED_NERD_FONT_FAMILY.toLowerCase())).toBe(true);
    expect(isBundledNerdFontFamily('Marcel Nerd Font Mono')).toBe(true);
    expect(isBundledNerdFontFamily('Marcel Nerd Font')).toBe(false);
  });
});

describe('buildTerminalFontFamily', () => {
  it('默认设置值：内置字体插在 monospace 之前，用户字体顺序不变', () => {
    expect(
      buildTerminalFontFamily('JetBrains Mono, Fira Code, Consolas, "Microsoft YaHei", monospace'),
    ).toBe(`JetBrains Mono, Fira Code, Consolas, "Microsoft YaHei", ${BUILTIN}, monospace`);
  });

  it('空值/纯空白：只用内置字体 + monospace（终端仍是等宽完整 Nerd Font）', () => {
    for (const empty of [undefined, null, '', '   ']) {
      expect(buildTerminalFontFamily(empty)).toBe(`${BUILTIN}, monospace`);
    }
  });

  // issue #15 的根因：字体名解析不到时浏览器会退回比例字体，字宽按 "W" 量出来 ~0.94em，
  // 窄字符被撑进宽格子 —— 出现「字间距异常」。末尾必须有 monospace 顶着。
  it('用户只填一个字体名（常见于 Nerd Font）：补内置字体与 monospace 兜底', () => {
    expect(buildTerminalFontFamily('JetBrainsMono Nerd Font')).toBe(
      `JetBrainsMono Nerd Font, ${BUILTIN}, monospace`,
    );
  });

  it('用户已给通用家族时不再额外补 monospace，内置字体插在它前面', () => {
    expect(buildTerminalFontFamily('Menlo, monospace')).toBe(`Menlo, ${BUILTIN}, monospace`);
    expect(buildTerminalFontFamily('Menlo, sans-serif')).toBe(`Menlo, ${BUILTIN}, sans-serif`);
  });

  it('用户自己写了内置字体名：不重复插入', () => {
    expect(buildTerminalFontFamily(BUNDLED_NERD_FONT_FAMILY)).toBe(
      `${BUNDLED_NERD_FONT_FAMILY}, monospace`,
    );
    expect(buildTerminalFontFamily(`${BUILTIN}, monospace`)).toBe(`${BUILTIN}, monospace`);
    expect(buildTerminalFontFamily(`Menlo, ${BUILTIN}, monospace`)).toBe(
      `Menlo, ${BUILTIN}, monospace`,
    );
  });

  it('幂等：把构造结果再喂一次结果不变（设置变更会重复下发同一字体栈）', () => {
    for (const value of [
      '',
      'JetBrainsMono Nerd Font',
      'JetBrains Mono, Fira Code, Consolas, "Microsoft YaHei", monospace',
      'Menlo, sans-serif',
    ]) {
      const once = buildTerminalFontFamily(value);
      expect(buildTerminalFontFamily(once)).toBe(once);
    }
  });

  it('保留用户写法（引号 / 带逗号的引号名 / 大小写）', () => {
    expect(buildTerminalFontFamily('"Foo, Bar", Consolas')).toBe(
      `"Foo, Bar", Consolas, ${BUILTIN}, monospace`,
    );
    expect(buildTerminalFontFamily('Hack NFM')).toBe(`Hack NFM, ${BUILTIN}, monospace`);
  });
});

describe('内置字体加载', () => {
  it('无 document.fonts 的环境下视为就绪，不抛错', async () => {
    await expect(ensureBundledNerdFontLoaded()).resolves.toBe(true);
    await expect(ensureBundledNerdFontLoaded()).resolves.toBe(true);
  });

  it('就绪回调会被触发（已就绪时走微任务）', async () => {
    const calls: string[] = [];
    onBundledNerdFontReady(() => calls.push('a'));
    onBundledNerdFontReady(() => calls.push('b'));
    expect(calls).toEqual([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(['a', 'b']);
  });

  it('退订后不再回调（终端销毁时要退订，避免留存监听）', async () => {
    vi.resetModules();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = vi.fn(async () => {
      await gate;
      return [{ family: BUNDLED_NERD_FONT_FAMILY }];
    });
    vi.stubGlobal('document', { fonts: { load } });
    try {
      const mod = await import('@/lib/terminalFont');
      const listening: string[] = [];
      const offKept = mod.onBundledNerdFontReady(() => listening.push('kept'));
      const offDropped = mod.onBundledNerdFontReady(() => listening.push('dropped'));
      offDropped();
      release!();
      await expect(mod.ensureBundledNerdFontLoaded()).resolves.toBe(true);
      await Promise.resolve();
      expect(listening).toEqual(['kept']);
      offKept();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // 生产构建里 @font-face 在 <link> 样式表里，注册可能晚于 JS 执行 —— 此时 fonts.load
  // 会返回空数组。若不重试，图标会一直按缺字渲染。
  it('@font-face 晚注册时重试到成功', async () => {
    vi.resetModules();
    // 断言的重试路径会打 console.warn（预期行为），静音以免污染测试输出。
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    const load = vi.fn(async () => {
      calls += 1;
      return calls < 3 ? [] : [{ family: BUNDLED_NERD_FONT_FAMILY }];
    });
    vi.stubGlobal('document', { fonts: { load } });
    try {
      const mod = await import('@/lib/terminalFont');
      await expect(mod.ensureBundledNerdFontLoaded()).resolves.toBe(true);
      expect(calls).toBe(3);
      expect(mod.isBundledNerdFontLoaded()).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      warn.mockRestore();
    }
  });

  it('加载抛错时立即判定失败，不无限重试', async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const load = vi.fn(async () => {
      throw new Error('boom');
    });
    vi.stubGlobal('document', { fonts: { load } });
    try {
      const mod = await import('@/lib/terminalFont');
      await expect(mod.ensureBundledNerdFontLoaded()).resolves.toBe(false);
      expect(load).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      warn.mockRestore();
    }
  });
});
