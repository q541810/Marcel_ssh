import { describe, expect, it } from 'vitest';
import { isTaskActive, isTaskBusy } from '@/lib/agentStatus';
import type { AgentStatus } from '@/lib/types';

/**
 * 分类意图的快照。
 *
 * 穷尽性由 `agentStatus.ts` 里两个不写 `default` 的 `switch` 在**编译期**保证
 * （`AgentStatus` 加成员 → `tsc` 报 TS2366，实测会指到那两个函数）。这条测试补
 * 的是另一半：分类改了、但「哪些状态算在跑」这层**意图**没跟着改的漂移 ——
 * 例如把 `waiting_approval` 挪进 `isTaskActive` 却没人察觉（那会让「有个任务卡在
 * 审批上」和「任务正在跑」在界面上变得一样）。
 */
describe('agentStatus 分类', () => {
  const ACTIVE: AgentStatus[] = ['planning', 'executing'];
  const BUSY_ONLY: AgentStatus[] = ['waiting_approval'];
  const TERMINAL: AgentStatus[] = ['completed', 'failed', 'cancelled'];

  it('isTaskActive：只在规划/执行中', () => {
    for (const s of ACTIVE) expect(isTaskActive(s), s).toBe(true);
    for (const s of [...BUSY_ONLY, ...TERMINAL]) expect(isTaskActive(s), s).toBe(false);
  });

  it('isTaskBusy：规划/执行/等待审批都算占用席位', () => {
    for (const s of [...ACTIVE, ...BUSY_ONLY]) expect(isTaskBusy(s), s).toBe(true);
    for (const s of TERMINAL) expect(isTaskBusy(s), s).toBe(false);
  });

  it('等待审批不算「在跑」但算「忙」——这个区分是界面的依据', () => {
    expect(isTaskActive('waiting_approval')).toBe(false);
    expect(isTaskBusy('waiting_approval')).toBe(true);
  });
});
