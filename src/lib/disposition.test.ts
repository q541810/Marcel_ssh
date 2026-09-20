import { describe, it, expect } from 'vitest';
import { normalizeDisposition } from './disposition';
import { DISPOSITION_COLORS, DISPOSITION_LABELS } from './constants';
import type { Disposition, LegacyDisposition } from './types';

/**
 * 后端 `Disposition` 的源码。用 vite 的 raw glob 读进来做文本比对：
 * 本仓库没装 @types/node，测试里不引 node API（与 `toolCatalog.test.ts` 同一手法）。
 */
const RUST = import.meta.glob('/src-tauri/src/agent/risk/disposition.rs', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const rustSource = Object.values(RUST)[0] ?? '';

/** 抽 `pub enum Disposition { ... }` 里的变体名、每个变体上的 serde 别名，以及枚举上方的属性区。 */
function parseRustEnum(src: string): { header: string; variants: string[]; aliases: Record<string, string[]> } {
  const start = src.indexOf('pub enum Disposition {');
  expect(start, 'disposition.rs 里找不到 `pub enum Disposition`').toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf('\n}', start));
  // 枚举上方的 derive/属性区：容器级 serde 属性（比如 `rename_all`）会改线上
  // 字符串 —— 加了它的话 normalizeDisposition 会静默落进 default 分支。
  const header = src.slice(Math.max(0, start - 400), start);
  const variants: string[] = [];
  const aliases: Record<string, string[]> = {};
  let pending: string[] = [];
  for (const line of body.split('\n')) {
    // 一行可能挂多个别名：`#[serde(alias = "ReadOnly", alias = "LowRisk")]`。
    const found = [...line.matchAll(/alias = "([A-Za-z0-9]+)"/g)].map((m) => m[1]);
    if (found.length > 0) {
      pending.push(...found);
      continue;
    }
    const variant = line.match(/^\s{4}([A-Z][A-Za-z0-9]*),\s*$/);
    if (variant) {
      variants.push(variant[1]);
      aliases[variant[1]] = pending;
      pending = [];
    }
  }
  return { header, variants, aliases };
}

describe('Disposition 与后端的对齐', () => {
  const { header, variants, aliases } = parseRustEnum(rustSource);

  it('后端源码能被解析到（防止 glob 路径写错后整组测试变成空转）', () => {
    expect(rustSource.length).toBeGreaterThan(0);
    expect(variants.length).toBeGreaterThan(0);
  });

  it('四档的名字、顺序、标签、配色一一对应', () => {
    expect(variants).toEqual(['Allow', 'Approval', 'ForceApproval', 'Deny']);

    // 顺序就是严重程度（后端靠 `Ord` 做「多段取最严」的 fold），所以这里
    // 断言的是数组相等而不是集合相等。
    const typed: Disposition[] = ['Allow', 'Approval', 'ForceApproval', 'Deny'];
    expect(typed).toEqual(variants);

    for (const v of variants) {
      expect(DISPOSITION_LABELS[v as Disposition], `${v} 缺中文档位名`).toBeTruthy();
      expect(DISPOSITION_COLORS[v as Disposition], `${v} 缺配色`).toBeTruthy();
    }
  });

  it('后端按变体名原样序列化（线上字符串就是 PascalCase 变体名）', () => {
    // 前端清单（`disposition.ts` 的 `normalizeDisposition` 输入）认的是
    // `Allow`/`Approval`/`ForceApproval`/`Deny` 这几个大写串。谁要是在枚举上加
    // 容器级 `rename_all`（比如 `snake_case` → `force_approval`），这条就红 —
    // 否则前端会静默落到 `Approval`（normalizeDisposition 的 default），弹窗的
    // 「强制审批」标签和 Auto 提示一起消失。
    expect(header).not.toContain('rename_all');
  });

  it('归一化表与后端的 serde 别名完全一致', () => {
    // 后端每个变体挂了哪些旧值别名，前端就必须把那些旧值折到同一个变体上。
    // 两边不一致的后果是：同一条历史记录，重启前后显示成不同的档位。
    const legacyValues: LegacyDisposition[] = [
      'ReadOnly',
      'LowRisk',
      'Moderate',
      'HighRisk',
      'Destructive',
    ];

    for (const v of variants) {
      for (const alias of aliases[v] ?? []) {
        expect(
          normalizeDisposition(alias),
          `后端把旧值 \`${alias}\` 映射到 ${v}，前端却映射到别处`,
        ).toBe(v);
      }
    }

    // 反向：前端认的每个旧值，后端也得有对应的别名，不能只有前端认。
    const allRustAliases = Object.values(aliases).flat();
    for (const legacy of legacyValues) {
      expect(allRustAliases, `旧值 \`${legacy}\` 在后端没有别名`).toContain(legacy);
    }
  });
});

/**
 * 这张表是前后端之间唯一一处"老数据还能读"的约定 —— 上面那组测试盯的就是它。
 */
describe('normalizeDisposition', () => {
  it('四档新值原样返回', () => {
    expect(normalizeDisposition('Allow')).toBe('Allow');
    expect(normalizeDisposition('Approval')).toBe('Approval');
    expect(normalizeDisposition('ForceApproval')).toBe('ForceApproval');
    expect(normalizeDisposition('Deny')).toBe('Deny');
  });

  it('旧的五档严重度按约定折进四档', () => {
    expect(normalizeDisposition('ReadOnly')).toBe('Allow');
    expect(normalizeDisposition('LowRisk')).toBe('Allow');
    expect(normalizeDisposition('Moderate')).toBe('Approval');
    expect(normalizeDisposition('HighRisk')).toBe('ForceApproval');
    expect(normalizeDisposition('Destructive')).toBe('ForceApproval');
  });

  it('认不出的值落到 Approval，不抛错', () => {
    // 一条读不懂的历史记录不该让整个会话打不开；保守起见按"需要审批"展示。
    for (const raw of [undefined, null, '', 'Medium', 'moderate', 42, {}, []]) {
      expect(normalizeDisposition(raw)).toBe('Approval');
    }
  });
});
