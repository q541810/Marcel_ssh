import { describe, it, expect } from 'vitest';

/**
 * 「作业结算告知」这条线的跨语言契约。
 *
 * 用 vite 的 raw glob 把两侧源码原文读进来比对（与 `turnState.test.ts` 同一手法，
 * 本仓库没装 @types/node，测试里不引 node API）：
 *
 * - 后端 `conversation_persister.rs`：`ROLE_NOTICE` 的**字面值**，以及
 *   `PromptOrigin` 两个变体的落库映射；
 * - 前端 `types.ts`：`AgentMessage.role` 里有 `notice`；
 * - 前端 `agentTurnFold.ts`：回合切分把 `notice` 当回合开头（否则那条告知会被
 *   并进上一轮的尾巴，把上一轮的折叠判定与答案定位全带偏）；
 * - 前端 `tauri.ts`：IPC 上那个来源字符串与后端的 `from_ipc` 认得的值一致。
 *
 * 任一侧改名/改值而另一侧没跟上，这里就红 —— 这类漂移不会报错，只会静默
 * 表现成「告知长成了用户气泡」「额度被自己的通知解封」。
 */
const RUST = import.meta.glob(
  ['/src-tauri/src/agent/conversation_persister.rs'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;
const TS = import.meta.glob(
  ['/src/lib/types.ts', '/src/lib/agentTurnFold.ts', '/src/lib/tauri.ts'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

const persister = RUST['/src-tauri/src/agent/conversation_persister.rs'] ?? '';
const types = TS['/src/lib/types.ts'] ?? '';
const fold = TS['/src/lib/agentTurnFold.ts'] ?? '';
const tauri = TS['/src/lib/tauri.ts'] ?? '';

/** 抽 `pub const NAME: &str = "value";` 的字面值。 */
function rustConst(src: string, name: string): string | null {
  const m = src.match(new RegExp(`pub const ${name}: &str = "([^"]+)"`));
  return m ? m[1] : null;
}

describe('作业告知（notice）的跨语言契约', () => {
  it('源码都读到了（防止 glob 路径写错后整组测试空转）', () => {
    expect(persister.length).toBeGreaterThan(0);
    expect(types.length).toBeGreaterThan(0);
    expect(fold.length).toBeGreaterThan(0);
    expect(tauri.length).toBeGreaterThan(0);
  });

  it('后端把它落成 role="notice"（不是冒充 user）', () => {
    expect(rustConst(persister, 'ROLE_NOTICE')).toBe('notice');
    // JobNotice → ROLE_NOTICE（自动继续那一轮的来源映射）
    expect(persister).toContain('Self::JobNotice => ROLE_NOTICE');
    // 用户打的字仍是 user
    expect(persister).toContain('Self::User => "user"');
  });

  it('前端消息角色里有 notice', () => {
    expect(types).toMatch(/role: 'user' \| 'assistant' \| 'system' \| 'tool' \| 'notice'/);
  });

  it('前端把 notice 当回合开头（与 user 同等）', () => {
    expect(fold).toContain("message.role === 'user' || message.role === 'notice'");
  });

  it('IPC 上的来源字符串与后端 from_ipc 认得的一致', () => {
    // 前端发的字面值
    expect(tauri).toContain("origin?: 'job_notice'");
    // 后端认的值（同一个字符串）
    expect(persister).toContain('Some("job_notice") => Self::JobNotice');
  });
});
