/**
 * 「interrupted 作业已读」记账的持久化（桌面 AgentTasksDrawer / 移动
 * MobileActiveAgentsSheet 共用同一份 localStorage）。
 *
 * 背景：重启恢复出来的 interrupted 作业是空闲状态下任务/作业中心的唯一入口
 * （见 `agentStatusSelectors.taskCenterEntry` 的注释），但入口同时是一颗琥珀
 * 警示胶囊——用户点开看过结局说明之后警示就该摘掉，不能挂着等台账保留期
 * （7 天）过期。记账后 `taskCenterEntry` 只把**未读**的 interrupted 计入警示。
 *
 * 形状：jobId → startedAtMillis。jobId 由落盘台账分配、跨应用运行单调递增
 * 永不复用（`manager.rs` 的 `allocate_job_num`，前缀区分远端/本机两台），
 * 所以 jobId 单独就能指认一条作业；startedAt 只为**修剪**服务——台账里
 * interrupted 记录按 started_at 计保留期，超期的作业不可能再出现在前端，
 * 对应的已读条目跟着过期，这份表才不会无限涨。
 */

import type { JobInfo } from '@/lib/types';

const STORAGE_KEY = 'marcel-read-interrupted-jobs';

/** 供测试 / 排查用：这份数据落在 localStorage 的哪个 key 下。 */
export const READ_INTERRUPTED_JOBS_STORAGE_KEY = STORAGE_KEY;

/** 已读条目的保留期：略长于台账的 7 天保留期（ledger.rs `RETENTION_MILLIS`）。 */
const RETENTION_MILLIS = 8 * 24 * 60 * 60 * 1000;

export type ReadInterruptedJobs = Record<string, number>;

type InterruptedJob = Pick<JobInfo, 'jobId' | 'status' | 'startedAtMillis'>;

/** 读初始已读状态；localStorage 不可用 / 数据损坏时返回空表（不报错、不清盘）。 */
export function loadReadInterruptedJobs(nowMillis = Date.now()): ReadInterruptedJobs {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return {};
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return pruneReadInterruptedJobs(parsed as ReadInterruptedJobs, nowMillis);
  } catch {
    return {};
  }
}

/** 把整份已读状态写回 localStorage；写失败不阻断记账（下次再试）。 */
export function saveReadInterruptedJobs(map: ReadInterruptedJobs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // localStorage 写失败不阻断
  }
}

/**
 * 记账的纯逻辑部分：把 jobs 里 interrupted 的作业并进已读表并修剪超期条目，
 * 返回新表；没有新记账时**原样返回 prev**（调用方据此跳过无谓的 store 更新
 * 与回写）。调用方负责随后 `saveReadInterruptedJobs`。
 */
export function markInterruptedJobsRead(
  prev: ReadInterruptedJobs,
  jobs: readonly InterruptedJob[],
  nowMillis = Date.now(),
): ReadInterruptedJobs {
  let next = prev;
  for (const job of jobs) {
    if (job.status === 'interrupted' && job.jobId && !(job.jobId in next)) {
      if (next === prev) next = { ...prev };
      next[job.jobId] = job.startedAtMillis;
    }
  }
  if (next === prev) return prev;
  return pruneReadInterruptedJobs(next, nowMillis);
}

/** 丢掉超期条目与形状不对的条目（旧版本写的、外部改坏的按不存在处理）。 */
function pruneReadInterruptedJobs(
  map: ReadInterruptedJobs,
  nowMillis: number,
): ReadInterruptedJobs {
  const out: ReadInterruptedJobs = {};
  for (const [jobId, startedAt] of Object.entries(map)) {
    if (!jobId) continue;
    if (typeof startedAt !== 'number') continue;
    if (nowMillis - startedAt <= RETENTION_MILLIS) {
      out[jobId] = startedAt;
    }
  }
  return out;
}
