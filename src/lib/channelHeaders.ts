/** 一条待编辑的请求头（草稿态，允许空行存在）。 */
export interface HeaderPair {
  name: string;
  value: string;
}

/** 受保护的协议头：这些由程序自己管，写了也不会生效，直接在 UI 上标出来。 */
const RESERVED = ['content-type', 'content-length', 'authorization'];

export function isReservedHeader(name: string): boolean {
  return RESERVED.includes(name.trim().toLowerCase());
}

/** 把 Record 转成草稿行（按 key 排序，顺序稳定）。 */
export function headersToPairs(headers: Record<string, string>): HeaderPair[] {
  return Object.entries(headers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => ({ name, value }));
}

/** 草稿行转回 Record：丢掉空名字的行；同名后者覆盖前者。 */
export function pairsToHeaders(pairs: HeaderPair[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const name = p.name.trim();
    if (!name) continue;
    out[name] = p.value;
  }
  return out;
}
