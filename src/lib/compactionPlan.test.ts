/**
 * 压缩方案前端算法测试（live store 原位替换 + checkpoint 输出）。
 *
 * 被测对象是 `messageConversion.ts` 里已落地的纯函数：
 *   historyRelevantMessages / compactionNormalizedRole / applyCompactionSplice /
 *   compactionCheckpoint。
 *
 * 覆盖：投影规则、校验式原位替换（含旧数据/孤儿 tool 漂移拒绝）、幂等、
 * 链式吞并（新卡吞旧卡、store 恒单卡）、checkpoint framing 逐字节镜像。
 *
 * 注意：持久化由后端结构化落库（count-walk + 指纹校验 + 归档 + 卡片定位，
 * `load_messages` 直接返回压缩视图），前端**不做**重启回放——后端与前端
 * 消息 id 是两个互不相交的域，任何 id 关联的回放都是死路。
 */
import { describe, it, expect } from 'vitest';
import type { AgentMessage } from './types';
import {
  applyCompactionSplice,
  compactionCheckpoint,
  historyRelevantMessages,
  compactionNormalizedRole,
  CHECKPOINT_PREAMBLE,
  type CompactionSpanSpec,
} from '../stores/messageConversion';

const SUMMARY_OPEN_TAG = '<compacted-summary>';
const SUMMARY_CLOSE_TAG = '</compacted-summary>';

// ───────────────────────── 测试数据辅助 ─────────────────────────

let seq = 0;
const u = (content: string): AgentMessage => ({ id: `u${++seq}`, role: 'user', content, timestamp: '' });
const a = (content: string): AgentMessage => ({ id: `a${++seq}`, role: 'assistant', content, timestamp: '' });
const t = (callId: string): AgentMessage => ({
  id: `t${++seq}`,
  role: 'tool',
  content: 'out',
  timestamp: '',
  toolResult: { toolName: 'cmd', summary: 'out', result: 'out', success: true, blocked: false, toolCallId: callId },
});
const legacyTool = (): AgentMessage => ({
  id: `t${++seq}`,
  role: 'tool',
  content: 'out',
  timestamp: '',
  toolResult: { toolName: 'cmd', summary: 'out', result: 'out', success: true, blocked: false }, // 无 toolCallId → buildLlmHistory 丢弃
});
const doneCard = (summary: string): AgentMessage => ({
  id: `c${++seq}`,
  role: 'system',
  content: `【上下文已压缩】已整理 3 条历史消息（约 1000 tokens）`,
  timestamp: '',
  compaction: { status: 'done', summary },
});
const runningCard = (): AgentMessage => ({
  id: `c${++seq}`,
  role: 'system',
  content: '上下文压缩中…',
  timestamp: '',
  compaction: { status: 'running' },
});
const notice = (): AgentMessage => ({ id: `s${++seq}`, role: 'system', content: '一些通知', timestamp: '' });

const isDoneCard = (m: AgentMessage) => m.role === 'system' && m.compaction?.status === 'done';

// ───────────────────────── 投影 ─────────────────────────

describe('historyRelevantMessages 投影', () => {
  it('跳过 loading 与 system 通知/运行中卡，计入 done 卡，保序且记录真实下标', () => {
    const m1 = u('u1');
    const n = notice();
    const rc = runningCard();
    const m2 = a('a1');
    const card = doneCard('s');
    const loading = { ...u('u2'), isLoading: true };
    const proj = historyRelevantMessages([m1, n, rc, m2, card, loading]);
    expect(proj.map((p) => p.m.id)).toEqual([m1.id, m2.id, card.id]);
    expect(proj.map((p) => p.i)).toEqual([0, 3, 4]);
  });

  it('done 卡归一化为 user 角色，与 loop 的 framed checkpoint 对齐', () => {
    expect(compactionNormalizedRole(doneCard('s'))).toBe('user');
    expect(compactionNormalizedRole(u('x'))).toBe('user');
    expect(compactionNormalizedRole(a('x'))).toBe('assistant');
    expect(compactionNormalizedRole(t('x'))).toBe('tool');
  });
});

// ───────────────────────── 原位替换 ─────────────────────────

describe('applyCompactionSplice 原位替换', () => {
  it('正路径：校验通过 → 删区间消息、原位插入卡片、返回被删 id', () => {
    const m1 = u('u1');
    const m2 = a('a1');
    const m3 = t('X1');
    const m4 = u('u2');
    const card = doneCard('sum1');
    const r = applyCompactionSplice(
      [m1, m2, m3, m4],
      { start: 0, count: 3, roles: ['user', 'assistant', 'tool'], toolIds: ['X1'] },
      card,
      null,
    );
    expect(r.applied).toBe(true);
    expect(r.removedIds).toEqual([m1.id, m2.id, m3.id]);
    expect(r.msgs.map((m) => m.id)).toEqual([card.id, m4.id]);
  });

  it('二次压缩：区间含上次的 done 卡（归一化为 user），正常替换', () => {
    const c1 = doneCard('s1');
    const m2 = u('u2');
    const m3 = a('a2');
    const m4 = t('X2');
    const m5 = u('u3');
    const c2 = doneCard('s2');
    const r = applyCompactionSplice(
      [c1, m2, m3, m4, m5],
      { start: 0, count: 4, roles: ['user', 'user', 'assistant', 'tool'], toolIds: ['X2'] },
      c2,
    );
    expect(r.applied).toBe(true);
    expect(r.removedIds).toEqual([c1.id, m2.id, m3.id, m4.id]);
    expect(r.msgs.map((m) => m.id)).toEqual([c2.id, m5.id]);
  });

  it('运行中卡在列表尾部、不计入投影；完成后被删除', () => {
    const m1 = u('u1');
    const m2 = t('X1');
    const rc = runningCard();
    const card = doneCard('s');
    const r = applyCompactionSplice(
      [m1, m2, rc],
      { start: 0, count: 2, roles: ['user', 'tool'], toolIds: ['X1'] },
      card,
      rc.id,
    );
    expect(r.applied).toBe(true);
    expect(r.msgs.map((m) => m.id)).toEqual([card.id]);
  });

  it('幂等：同一载荷应用两次，第二次 no-op（区间已被替换）', () => {
    const m1 = u('u1');
    const m2 = t('X1');
    const card = doneCard('s');
    const span: CompactionSpanSpec = { start: 0, count: 2, roles: ['user', 'tool'], toolIds: ['X1'] };
    const once = applyCompactionSplice([m1, m2], span, card);
    expect(once.applied).toBe(true);
    const twice = applyCompactionSplice(once.msgs, span, card);
    expect(twice.applied).toBe(false);
    expect(twice.msgs).toEqual(once.msgs);
  });

  it('store 比 loop 短（事件丢失）：越界 → 拒绝，不动任何消息', () => {
    const msgs = [u('u1'), t('X1')];
    const card = doneCard('s');
    const r = applyCompactionSplice(
      msgs,
      { start: 0, count: 4, roles: ['user', 'tool', 'user', 'user'], toolIds: ['X1'] },
      card,
    );
    expect(r.applied).toBe(false);
    expect(r.msgs).toEqual(msgs);
  });

  it('旧数据多出一条被丢弃的 legacy tool（无 toolCallId）：角色序列不一致 → 拒绝', () => {
    const m1 = u('u1');
    const m2 = a('a1');
    const m3 = t('X1');
    const legacy = legacyTool(); // buildLlmHistory 会丢弃它 → loop 序列里没有
    const m4 = u('u2');
    const msgs = [m1, m2, m3, legacy, m4];
    const card = doneCard('s');
    // loop 视角：区间 = [u1, a1, t1, u2]（legacy 不在）
    const r = applyCompactionSplice(
      msgs,
      { start: 0, count: 4, roles: ['user', 'assistant', 'tool', 'user'], toolIds: ['X1'] },
      card,
    );
    expect(r.applied).toBe(false);
    expect(r.msgs).toEqual(msgs);
  });

  it('tool 调用 id 序列不一致（含 legacy 卡位错乱）→ 拒绝', () => {
    const m1 = u('u1');
    const m2 = t('X1');
    const legacy = legacyTool(); // 无 id，不贡献 toolId
    const m3 = t('X2');
    const msgs = [m1, m2, legacy, m3];
    const card = doneCard('s');
    // loop 视角：区间 = [u1, t1, t2]，toolIds = [X1, X2]
    const r = applyCompactionSplice(
      msgs,
      { start: 0, count: 3, roles: ['user', 'tool', 'tool'], toolIds: ['X1', 'X2'] },
      card,
    );
    expect(r.applied).toBe(false);
    expect(r.msgs).toEqual(msgs);
  });
});

// ───────────────────────── checkpoint 与历史构建 ─────────────────────────

describe('compactionCheckpoint（buildLlmHistory 压缩分支）', () => {
  it('done 卡 → user 角色，framing 与后端逐字节一致', () => {
    const card = doneCard('## Primary Request\n- build a terminal');
    const cp = compactionCheckpoint(card);
    expect(cp).toEqual({
      role: 'user',
      content:
        `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}\n` +
        '## Primary Request\n- build a terminal\n' +
        `${SUMMARY_CLOSE_TAG}`,
    });
  });

  it('运行中卡 / 无摘要的 done 卡 → 不输出 checkpoint', () => {
    expect(compactionCheckpoint(runningCard())).toBeNull();
    expect(compactionCheckpoint({ ...doneCard('s'), compaction: { status: 'done' } })).toBeNull();
  });
});

// ───────────────────────── 多卡片场景 ─────────────────────────

describe('多卡片场景（live store）', () => {
  it('三连压缩：新卡吞旧卡，store 恒只有最新一张卡，历史只剩最新 checkpoint', () => {
    const m1 = u('u1');
    const m2 = a('a1');
    const m3 = t('X1');
    const m4 = u('u2');
    const m5 = a('a2');
    const m6 = t('X2');
    const m7 = u('u3');
    const m8 = a('a3');
    const m9 = t('X3');
    const m10 = u('u4');
    let store: AgentMessage[] = [m1, m2, m3, m4, m5, m6, m7, m8, m9, m10];

    // ── 压缩 1：压 [u1, a1, t1] ──
    let r = applyCompactionSplice(
      store,
      { start: 0, count: 3, roles: ['user', 'assistant', 'tool'], toolIds: ['X1'] },
      doneCard('s1'),
      null,
    );
    expect(r.applied).toBe(true);
    store = r.msgs;
    expect(store.filter(isDoneCard)).toHaveLength(1);
    expect(store.map((m) => m.id)).toEqual([r.msgs[0].id, m4.id, m5.id, m6.id, m7.id, m8.id, m9.id, m10.id]);

    // ── 压缩 2：区间含上次的卡 → 压 [c1, u2, a2, t2, u3]（平衡切点）──
    r = applyCompactionSplice(
      store,
      { start: 0, count: 5, roles: ['user', 'user', 'assistant', 'tool', 'user'], toolIds: ['X2'] },
      doneCard('s2'),
      null,
    );
    expect(r.applied).toBe(true);
    store = r.msgs;
    expect(store.filter(isDoneCard)).toHaveLength(1);
    expect(store.map((m) => m.id)).toEqual([r.msgs[0].id, m8.id, m9.id, m10.id]);

    // ── 压缩 3：压 [c2] ──
    r = applyCompactionSplice(
      store,
      { start: 0, count: 1, roles: ['user'], toolIds: [] },
      doneCard('s3'),
      null,
    );
    expect(r.applied).toBe(true);
    store = r.msgs;
    expect(store.filter(isDoneCard)).toHaveLength(1);
    expect(store.map((m) => m.id)).toEqual([r.msgs[0].id, m8.id, m9.id, m10.id]);

    // 历史输出只有一个 checkpoint（最新摘要），且位于头部
    const history = walkHistory(store);
    const checkpoints = history.filter((h) => h.content.includes(SUMMARY_OPEN_TAG));
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].content).toContain('s3');
    expect(history[0].content).toContain('s3');
  });

  it('done 卡与运行中卡并存：splice 吞掉旧 done 卡并移除运行中卡，只留新卡', () => {
    const cPrev = doneCard('s-old');
    const m2 = u('u2');
    const m3 = t('X2');
    const m4 = u('u3');
    const rc = runningCard();
    const cNew = doneCard('s-new');
    const r = applyCompactionSplice(
      [cPrev, m2, m3, m4, rc],
      { start: 0, count: 3, roles: ['user', 'user', 'tool'], toolIds: ['X2'] },
      cNew,
      rc.id,
    );
    expect(r.applied).toBe(true);
    expect(r.removedIds).toEqual([cPrev.id, m2.id, m3.id]);
    expect(r.msgs.map((m) => m.id)).toEqual([cNew.id, m4.id]);
  });
});

/** 历史构建的压缩相关分支（真实 buildLlmHistory 中 system 分支的替代）。 */
function walkHistory(msgs: AgentMessage[]): Array<{ role: string; content: string }> {
  const out: Array<{ role: string; content: string }> = [];
  for (const m of msgs) {
    if (m.isLoading) continue;
    if (m.role === 'system') {
      const cp = compactionCheckpoint(m);
      if (cp) out.push(cp);
      continue; // 其余 system（通知/运行中卡）跳过
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}
