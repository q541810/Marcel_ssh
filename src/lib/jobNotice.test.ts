import { describe, it, expect } from 'vitest';
import { parseJobNotice } from '@/lib/jobNotice';

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
 * - 后端 `agent_loop/mod.rs` ↔ 前端 `jobNotice.ts` / `AgentMessage.tsx`：告知**正文
 *   的行格式**（界面把它拆成标题行与展开区）与状态文案的配色覆盖。
 *   （agent_loop.rs 已拆为目录模块，告知格式串在 mod.rs。）
 *
 * 任一侧改名/改值/改格式而另一侧没跟上，这里就红 —— 这类漂移不会报错，只会
 * 静默表现成「告知长成了用户气泡」「额度被自己的通知解封」「标题行只剩一串
 * 原文」。
 */
const RUST = import.meta.glob(
  [
    '/src-tauri/src/agent/conversation_persister.rs',
    '/src-tauri/src/agent/agent_loop/mod.rs',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;
const TS = import.meta.glob(
  [
    '/src/lib/types.ts',
    '/src/lib/agentTurnFold.ts',
    '/src/lib/tauri.ts',
    '/src/components/agent/AgentMessage.tsx',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

const persister = RUST['/src-tauri/src/agent/conversation_persister.rs'] ?? '';
const agentLoop = RUST['/src-tauri/src/agent/agent_loop/mod.rs'] ?? '';
const types = TS['/src/lib/types.ts'] ?? '';
const fold = TS['/src/lib/agentTurnFold.ts'] ?? '';
const tauri = TS['/src/lib/tauri.ts'] ?? '';
const agentMessage = TS['/src/components/agent/AgentMessage.tsx'] ?? '';

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

  it('告知正文的行格式：后端这么写，前端这么拆', () => {
    // 界面把告知渲染成一张卡：标题行要 id / 描述 / 状态，给模型的指令进展开区。
    // 两边靠这条格式串咬合，改了后端这里会红（前端会静默回落成「只剩一串原文」）。
    expect(agentLoop).toContain('format!("后台作业 {}（{}）{}"');
  });

  it('后端给出的每种作业状态，界面都有配色', () => {
    const labels = [...agentLoop.matchAll(/JobStatus::\w+ => "([^"]+)"/g)].map(
      (m) => m[1],
    );
    // 五个变体：已完成 / 已被终止 / 执行失败 / 随应用退出中断 / 仍在运行
    expect(labels.length).toBeGreaterThanOrEqual(5);
    for (const label of labels) {
      expect(
        agentMessage,
        `状态「${label}」在 AgentMessage.tsx 的 JOB_STATUS_STYLE 里没有配色`,
      ).toMatch(new RegExp(`^  ${label}: \\{`, 'm'));
    }
  });
});

describe('parseJobNotice', () => {
  it('单作业：拆出 id / 描述 / 状态，指令归 notes', () => {
    expect(
      parseJobNotice('后台作业 job_3（构建）已完成\n用 job_output 读输出并纳入结论。'),
    ).toEqual({
      jobs: [{ jobId: 'job_3', description: '构建', status: '已完成' }],
      notes: ['用 job_output 读输出并纳入结论。'],
    });
  });

  it('描述里带全角括号：id 与状态各归各位', () => {
    // 贪婪的 `(\S+)` 会把 id 切成「job_7（构建」、描述切成「release）」（踩过）
    const { jobs } = parseJobNotice('后台作业 job_7（构建（release））执行失败');
    expect(jobs).toEqual([
      { jobId: 'job_7', description: '构建（release）', status: '执行失败' },
    ]);
  });

  it('描述为空时后端回退成命令原文：原样收着', () => {
    const { jobs } = parseJobNotice('后台作业 job_9（ls -la /tmp）已完成');
    expect(jobs[0]).toEqual({
      jobId: 'job_9',
      description: 'ls -la /tmp',
      status: '已完成',
    });
  });

  it('多行多个作业：顺序不变', () => {
    const { jobs } = parseJobNotice(
      '后台作业 job_1（构建）已完成\n后台作业 job_2（部署）执行失败',
    );
    expect(jobs.map((j) => j.jobId)).toEqual(['job_1', 'job_2']);
  });

  it('认不出的行不丢：原文进 notes', () => {
    const { jobs, notes } = parseJobNotice('这行不是作业行\n后台作业 job_3（构建）已完成');
    expect(jobs).toHaveLength(1);
    expect(notes).toEqual(['这行不是作业行']);
  });
});
