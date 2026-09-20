import { describe, it, expect } from 'vitest';
import { TURN_STATES } from './types';

/**
 * 后端源码。用 vite 的 raw glob 读进来做文本比对：本仓库没装 @types/node，
 * 测试里不引 node API（与 `disposition.test.ts` / `toolCatalog.test.ts` 同一手法）。
 * - `task.rs`：`TurnState` 枚举（变体名 / 序列化大小写）
 * - `conversation.rs`：`StoredMessage`（字段名与线名）
 */
const RUST = import.meta.glob(
  ['/src-tauri/src/agent/task.rs', '/src-tauri/src/agent/conversation.rs'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

const rustSource = RUST['/src-tauri/src/agent/task.rs'] ?? '';
const dbSource = RUST['/src-tauri/src/agent/conversation.rs'] ?? '';

/** 抽 `pub enum TurnState { … }` 的头部与变体名（每个变体独占一行）。 */
function parseRustTurnState(src: string): { header: string; variants: string[] } {
  const start = src.indexOf('pub enum TurnState {');
  expect(start, 'task.rs 里找不到 `pub enum TurnState`').toBeGreaterThan(-1);
  const end = src.indexOf('\n}', start);
  const body = src.slice(start, end);
  const variants: string[] = [];
  for (const line of body.split('\n')) {
    const variant = line.match(/^\s{4}([A-Z][A-Za-z0-9]*),\s*$/);
    if (variant) variants.push(variant[1]);
  }
  // 变体上面挂的 serde 属性（决定落库/线上字符串怎么写）
  const header = src.slice(Math.max(0, start - 200), start);
  return { header, variants };
}

describe('TurnState 与后端的对齐', () => {
  const { header, variants } = parseRustTurnState(rustSource);

  it('后端源码能被解析到（防止 glob 路径写错后整组测试变成空转）', () => {
    expect(rustSource.length).toBeGreaterThan(0);
    expect(variants.length).toBeGreaterThan(0);
  });

  it('变体名小写后与前端清单逐一对应', () => {
    // 变体名小写 = 落库字符串（rename_all = "lowercase" + as_str()），
    // 前端按同一套字符串匹配，任何一边加/改变体这里都会红。
    expect(variants.map((v) => v.toLowerCase())).toEqual([...TURN_STATES]);
  });

  it('后端确实按小写序列化（前端清单是小写的依据）', () => {
    expect(header).toContain('#[serde(rename_all = "lowercase")]');
  });

  it('StoredMessage 的字段名对上（camelCase `turnState` ← `turn_state`）', () => {
    // 前端 `messageConversion` 读的就是 `m.turnState`：Rust 侧把字段改名、
    // 或把结构体的 rename_all 去掉，读到的就是 undefined —— 静默退回
    // 「没有记录」，本次修复等于没做。这条把线名钉住。
    const structStart = dbSource.indexOf('pub struct StoredMessage {');
    expect(structStart, 'conversation.rs 里找不到 StoredMessage').toBeGreaterThan(-1);
    const structHead = dbSource.slice(Math.max(0, structStart - 200), structStart);
    expect(structHead).toContain('#[serde(rename_all = "camelCase")]');
    expect(dbSource.slice(structStart)).toContain('pub turn_state: Option<String>');
  });
});
