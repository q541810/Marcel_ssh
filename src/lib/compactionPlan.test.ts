/**
 * 压缩方案前端算法测试（id 指针定位 + checkpoint 输出）。
 *
 * 被测对象是 `messageConversion.ts` 里已落地的纯函数：
 *   applyCompactionSplice / compactionCheckpoint。
 *
 * 覆盖：id 指针定位插入（原文全保留、卡片插在被压末条之后）、吸收旧卡 +
 * 移除运行中卡、幂等、找不到指针的降级（不插卡、不屏蔽）、无校验语义
 * （legacy/孤儿 tool 行不影响定位）、checkpoint framing 逐字节镜像。
 *
 * 注意：持久化由后端按同一 id 结构化落库（卡片 created_at = 被压末行，
 * `load_messages` 行序 = 原文 + 卡片紧贴末条），前端**不做**重启回放——
 * 前后端消息 id 是同一个域（DB row id，前端 `dbId`），任何定位都按 id。
 */
import { describe, it, expect } from 'vitest';
import type { AgentMessage } from './types';
import {
  applyCompactionSplice,
  compactionCheckpoint,
  CHECKPOINT_PREAMBLE,
} from '../stores/messageConversion';

const SUMMARY_OPEN_TAG = '<compacted-summary>';
const SUMMARY_CLOSE_TAG = '</compacted-summary>';

// ───────────────────────── 测试数据辅助 ─────────────────────────

let seq = 0;
const u = (content: string, dbId?: string): AgentMessage => ({
  id: `u${++seq}`,
  role: 'user',
  content,
  timestamp: '',
  ...(dbId ? { dbId } : {}),
});
const a = (content: string, dbId?: string): AgentMessage => ({
  id: `a${++seq}`,
  role: 'assistant',
  content,
  timestamp: '',
  ...(dbId ? { dbId } : {}),
});
const t = (callId: string, dbId?: string): AgentMessage => ({
  id: `t${++seq}`,
  role: 'tool',
  content: 'out',
  timestamp: '',
  toolResult: {
    toolName: 'cmd',
    summary: 'out',
    result: 'out',
    success: true,
    blocked: false,
    toolCallId: callId,
  },
  ...(dbId ? { dbId } : {}),
});
const legacyTool = (dbId?: string): AgentMessage => ({
  id: `t${++seq}`,
  role: 'tool',
  content: 'out',
  timestamp: '',
  toolResult: {
    toolName: 'cmd',
    summary: 'out',
    result: 'out',
    success: true,
    blocked: false,
  }, // 无 toolCallId → buildLlmHistory 丢弃
  ...(dbId ? { dbId } : {}),
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

// ───────────────────────── applyCompactionSplice ─────────────────────────

describe('applyCompactionSplice id 指针定位', () => {
  it('正路径：tailDbId 命中 → 卡片插在被压末条之后，原文全保留', () => {
    const m1 = u('u1', 'row-1');
    const m2 = a('a1', 'row-2');
    const m3 = u('u2', 'row-3');
    const m4 = u('u3', 'row-4');
    const msgs = [m1, m2, m3, m4];
    const r = applyCompactionSplice(msgs, { tailDbId: 'row-3' }, doneCard('s'));
    expect(r.applied).toBe(true);
    expect(r.msgs).toHaveLength(5);
    expect(r.msgs[0].id).toBe(m1.id);
    expect(r.msgs[1].id).toBe(m2.id);
    expect(r.msgs[2].id).toBe(m3.id);
    expect(r.msgs[3].compaction?.status).toBe('done'); // 卡片紧贴 row-3
    expect(r.msgs[4].id).toBe(m4.id);
  });

  it('手动压到最末：tailDbId = 最后一条 → 卡片在对话末尾', () => {
    const m1 = u('u1', 'row-1');
    const m2 = a('a1', 'row-2');
    const r = applyCompactionSplice([m1, m2], { tailDbId: 'row-2' }, doneCard('s'));
    expect(r.applied).toBe(true);
    expect(r.msgs[r.msgs.length - 1].compaction?.status).toBe('done');
  });

  it('二次压缩：吸收末条之前最近一张旧卡 + 移除运行中卡', () => {
    const m1 = u('u1', 'row-1');
    const m2 = a('a1', 'row-2');
    const oldCard = doneCard('old');
    const m3 = u('u2', 'row-4');
    const running = runningCard();
    const msgs = [m1, m2, oldCard, m3, running];
    const r = applyCompactionSplice(msgs, { tailDbId: 'row-4' }, doneCard('new'), running.id);
    expect(r.applied).toBe(true);
    // 原文 3 条 + 新卡 = 4（旧卡与运行中卡被移除）
    expect(r.msgs).toHaveLength(4);
    expect(r.msgs.some((m) => m.id === oldCard.id)).toBe(false);
    expect(r.msgs.some((m) => m.id === running.id)).toBe(false);
    const cardIdx = r.msgs.findIndex((m) => m.compaction?.status === 'done');
    expect(r.msgs[cardIdx - 1].id).toBe(m3.id); // 新卡在 row-4 之后
  });

  it('幂等：末条之后已有 done 卡 → no-op', () => {
    const m1 = u('u1', 'row-1');
    const m2 = u('u2', 'row-2');
    const card = doneCard('s');
    const msgs = [m1, m2, card]; // row-2 之后已有卡
    const r = applyCompactionSplice(msgs, { tailDbId: 'row-2' }, doneCard('dup'));
    expect(r.applied).toBe(false);
    expect(r.msgs).toEqual(msgs);
  });

  it('找不到 tailDbId（无 dbId / 悬空 id）→ 降级不插卡，原文保留', () => {
    const m1 = u('u1', 'row-1');
    const m2 = u('u2'); // 运行中消息，无 dbId
    const r = applyCompactionSplice([m1, m2], { tailDbId: null }, doneCard('s'));
    expect(r.applied).toBe(false);
    expect(r.msgs).toEqual([m1, m2]);

    const r2 = applyCompactionSplice([m1], { tailDbId: 'ghost' }, doneCard('s'));
    expect(r2.applied).toBe(false);
    expect(r2.msgs).toEqual([m1]);
  });

  it('无校验：legacy/孤儿 tool 行不影响定位（tailDbId 命中即应用）', () => {
    const m1 = u('u1', 'row-1');
    const legacy = legacyTool('row-2'); // 无 toolCallId
    const m3 = u('u2', 'row-3');
    const r = applyCompactionSplice([m1, legacy, m3], { tailDbId: 'row-3' }, doneCard('s'));
    expect(r.applied).toBe(true);
    expect(r.msgs).toHaveLength(4);
    expect(r.msgs[3].compaction?.status).toBe('done');
  });

  it('手动（manual）：队尾语义，不依赖 tailDbId——移除旧 done 卡 + 运行中卡，卡片在末尾', () => {
    const m1 = u('u1', 'row-1');
    const m2 = a('a1', 'row-2');
    const oldCard = doneCard('old');
    const m3 = u('u2', 'row-4');
    const running = runningCard();
    const msgs = [m1, m2, oldCard, m3, running];
    // 全新会话场景：tailDbId 为 null，消息可能无 dbId——手动队尾照常生效
    const r = applyCompactionSplice(msgs, { tailDbId: null }, doneCard('new'), running.id, {
      manual: true,
    });
    expect(r.applied).toBe(true);
    // 原文 3 条 + 新卡 = 4（旧 done 卡与运行中卡被移除）；卡片在队尾
    expect(r.msgs).toHaveLength(4);
    expect(r.msgs.some((m) => m.id === oldCard.id)).toBe(false);
    expect(r.msgs.some((m) => m.id === running.id)).toBe(false);
    expect(r.msgs[r.msgs.length - 1].compaction?.status).toBe('done');
    expect(r.msgs.map((m) => m.id)).toEqual([m1.id, m2.id, m3.id, r.msgs[r.msgs.length - 1].id]);
  });

  it('手动：尾部有 system 通知时卡片仍追加到末尾（buildLlmHistory 跳过通知，无影响）', () => {
    const m1 = u('u1', 'row-1');
    const note = { id: 's1', role: 'system' as const, content: '一些通知', timestamp: '' };
    const r = applyCompactionSplice([m1, note], { tailDbId: null }, doneCard('s'), undefined, {
      manual: true,
    });
    expect(r.applied).toBe(true);
    expect(r.msgs[r.msgs.length - 1].compaction?.status).toBe('done');
    expect(r.msgs).toHaveLength(3);
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
  it('三连压缩：原文永不移除，旧卡被吸收，store 恒只有一张 done 卡', () => {
    const m1 = u('u1', 'r1');
    const m2 = a('a1', 'r2');
    const m3 = t('X1', 'r3');
    const m4 = u('u2', 'r4');
    const m5 = a('a2', 'r5');
    const m6 = u('u3', 'r6');
    let msgs = [m1, m2, m3, m4, m5, m6];

    // 第一次：压到 m3
    let r = applyCompactionSplice(msgs, { tailDbId: 'r3' }, doneCard('s1'));
    expect(r.applied).toBe(true);
    msgs = r.msgs;
    expect(msgs.filter((m) => m.compaction?.status === 'done')).toHaveLength(1);
    expect(msgs).toHaveLength(7); // 原文 6 + 卡 1

    // 第二次：压到 m5（吸收旧卡）
    r = applyCompactionSplice(msgs, { tailDbId: 'r5' }, doneCard('s2'));
    expect(r.applied).toBe(true);
    msgs = r.msgs;
    expect(msgs.filter((m) => m.compaction?.status === 'done')).toHaveLength(1);
    expect(msgs).toHaveLength(7); // 原文 6 + 新卡（旧卡被吸收）

    // 第三次：压到 m6
    r = applyCompactionSplice(msgs, { tailDbId: 'r6' }, doneCard('s3'));
    expect(r.applied).toBe(true);
    msgs = r.msgs;
    expect(msgs.filter((m) => m.compaction?.status === 'done')).toHaveLength(1);
    expect(msgs).toHaveLength(7); // 原文永不移除
    // 卡片在 m6 之后 = 对话末尾
    expect(msgs[msgs.length - 1].compaction?.status).toBe('done');
    expect(msgs[msgs.length - 2].id).toBe(m6.id);
  });

  it('done 卡与运行中卡并存：吸收旧 done 卡并移除运行中卡，原文保留', () => {
    const m1 = u('u1', 'r1');
    const m2 = a('a1', 'r2');
    const oldCard = doneCard('old');
    const m3 = u('u2', 'r3');
    const running = runningCard();
    const msgs = [m1, m2, oldCard, m3, running];
    const r = applyCompactionSplice(msgs, { tailDbId: 'r3' }, doneCard('new'), running.id);
    expect(r.applied).toBe(true);
    expect(r.msgs.filter((m) => m.compaction?.status === 'done')).toHaveLength(1);
    expect(r.msgs).toHaveLength(4);
    expect(r.msgs[3].compaction?.status).toBe('done');
  });
});
