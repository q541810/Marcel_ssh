/**
 * 设计令牌守门：新代码不许绕过令牌写具体值（规则见 src/lib/AGENTS.md「设计令牌」）。
 * 真有理由例外的文件登记在 EXEMPT，并写明原因。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..');

const BANNED: { re: RegExp; use: string }[] = [
  { re: /(?<![\w\-[])(text|placeholder)-zinc-(100|200|300|400|500|600)(?![\w-])/, use: 'text-fg / fg-secondary / fg-tertiary / fg-disabled' },
  { re: /(?<![\w\-[])bg-zinc-(950|900|800)(?![\w-])/, use: 'bg-surface-sunken / bg-surface / bg-surface-raised' },
  { re: /(?<![\w\-[])text-\[\d+(\.\d+)?px\](?![\w-])/, use: 'text-caption / meta / body / read / title / headline' },
  { re: /(?<![\w\-[])text-(xs|sm)(?![\w-])/, use: 'text-meta / text-body / text-read' },
  { re: /(?<![\w\-[])transition-all(?![\w-])/, use: 'transition-colors / -opacity / -transform 或明确属性' },
  { re: /(?<![\w\-[])rounded(-[trblse]{1,2})?-\[\d+(\.\d+)?(px|rem)\](?![\w-])/, use: 'rounded-sm/md/lg/xl/2xl/full' },
  { re: /(?<![\w\-[])bg-field(?![\w-])/, use: 'field 工具类（底色、描边、悬停、聚焦环、出错态一次给齐，别手拼 bg-field + border-*）' },
  { re: /<select[\s>]/, use: '@/components/ui/Select（桌面）或 MobileSelect（手机）：原生下拉弹出的是系统白底列表，不跟主题、没有连续圆角' },
];

/** 相对 src/ 的路径 → 例外原因 */
const EXEMPT: Record<string, string> = {
  'lib/uiTheme.ts': '主题系统本身，注释里描述的是 Tailwind 调色板变量',
  'lib/uiTheme.test.ts': '同上',
  'lib/designTokens.test.ts': '本文件',
  'components/settings/RiskLevelSelect.tsx': '手机档位下拉的触发按钮按档位染描边与文字色（RULE_LEVEL_TONE），只借输入槽底色',
};

function walk(dir: string, out: string[]) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(name)) out.push(p);
  }
}

describe('design tokens', () => {
  it('源码不绕过设计令牌写具体颜色/字号/圆角/transition-all', () => {
    const files: string[] = [];
    walk(SRC, files);
    const hits: string[] = [];
    for (const file of files) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      if (EXEMPT[rel]) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        for (const { re, use } of BANNED) {
          const m = line.match(re);
          if (m) hits.push(`${rel}:${i + 1}  ${m[0]}  → 用 ${use}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });
});
