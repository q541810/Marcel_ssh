import { create } from 'zustand';
import type { JobInfo } from '@/lib/types';
import { invoke } from '@tauri-apps/api/core';
import { subscribeTauriEvent } from '@/lib/tauriEvent';
import { getErrorMessage } from '@/lib/errors';
import {
  loadReadInterruptedJobs,
  markInterruptedJobsRead as markReadInterrupted,
  saveReadInterruptedJobs,
  type ReadInterruptedJobs,
} from '@/lib/jobReadState';
import * as tauri from '@/lib/tauri';

interface JobState {
  /** 全部已知作业（运行中 + 已完结），按 jobId 索引。 */
  jobs: Record<string, JobInfo>;
  /**
   * 已读的 interrupted 作业（jobId → startedAtMillis，lib/jobReadState 持久化）：
   * 用户在任务/作业中心看过结局说明的。警示胶囊只数**未读**的 interrupted
   * （见 `taskCenterEntry`）——否则这颗警示要挂满台账的 7 天保留期。
   */
  readInterrupted: ReadInterruptedJobs;
  /**
   * 拉取后台作业列表并合并进 store。
   * @param sessionId 会话 ID；空 / null = 拉取全部会话的作业（启动恢复用）。
   * 只 upsert 合并、绝不整体替换（避免回退事件已带来的更新状态）。
   * 拉取失败静默 warn，不 throw（best-effort，不阻塞启动/连接）。
   */
  fetchJobs: (sessionId?: string | null) => Promise<void>;
  killJob: (jobId: string) => Promise<void>;
  upsertJob: (job: JobInfo) => void;
  /**
   * 把这批作业里的 interrupted 记成已读（任务/作业中心的 Jobs 页签亮出来时调，
   * 桌面抽屉与移动端 sheet 共用同一口径）。没有新记账时不更新 store、不回写。
   */
  markInterruptedJobsRead: (jobs: JobInfo[]) => void;
  /** 监听后端 job://started / job://updated 事件；返回解绑函数。 */
  initEventListener: () => () => void;
}

/**
 * 后端 JobInfo（snake_case serde）→ 前端 camelCase。
 *
 * **凡是拿到后端作业载荷的地方都要过这里**（`job_list` / `job_kill`，以及
 * `job://started` / `job://updated` 两个事件的载荷）：后端 serde 没写 camelCase
 * 别名，事件里直接发出来的是 `owner_conversation_id` 这种形状，按 camelCase 读
 * 只会读到 `undefined`。逐字段两种拼写都认，是为了不管哪一侧先改名都不会静默
 * 退化成空值。
 */
export function mapJob(raw: Record<string, unknown>): JobInfo {
  return {
    jobId: String(raw.job_id ?? raw.jobId ?? ''),
    sessionId: String(raw.session_id ?? raw.sessionId ?? ''),
    taskId:
      raw.task_id != null
        ? String(raw.task_id)
        : raw.taskId != null
          ? String(raw.taskId)
          : null,
    description: String(raw.description ?? ''),
    command: String(raw.command ?? ''),
    status: (raw.status as JobInfo['status']) ?? 'running',
    ownerConversationId:
      raw.owner_conversation_id != null
        ? String(raw.owner_conversation_id)
        : raw.ownerConversationId != null
          ? String(raw.ownerConversationId)
          : null,
    // 结算细节（退出码 / 信号 / 失败原因）：缺省就是没记过，展示层不编造。
    detail: raw.detail != null ? String(raw.detail) : null,
    startedAtMillis: Number(raw.started_at_millis ?? raw.startedAtMillis ?? Date.now()),
    finishedAtMillis:
      raw.finished_at_millis != null
        ? Number(raw.finished_at_millis)
        : raw.finishedAtMillis != null
          ? Number(raw.finishedAtMillis)
          : null,
    totalOutputBytes: Number(raw.total_output_bytes ?? raw.totalOutputBytes ?? 0),
  };
}

export const useJobStore = create<JobState>((set, get) => ({
  jobs: {},

  readInterrupted: loadReadInterruptedJobs(),

  fetchJobs: async (sessionId?: string | null) => {
    try {
      const rawList = await tauri.jobList(sessionId ?? null, null);
      const list = Array.isArray(rawList) ? rawList : [];
      for (const job of list) {
        get().upsertJob(mapJob(job as unknown as Record<string, unknown>));
      }
    } catch (e) {
      // best-effort：拉取失败不阻塞启动/连接，事件监听仍会持续更新
      console.warn('[jobStore] fetchJobs failed:', getErrorMessage(e));
    }
  },

  killJob: async (jobId: string) => {
    try {
      const res = await invoke<Record<string, unknown>>('job_kill', { jobId });
      get().upsertJob(mapJob(res));
    } catch (e) {
      console.error('Failed to kill job:', getErrorMessage(e));
    }
  },

  upsertJob: (job: JobInfo) => {
    set((s) => ({
      jobs: {
        ...s.jobs,
        [job.jobId]: {
          ...(s.jobs[job.jobId] || {}),
          ...job,
        },
      },
    }));
  },

  markInterruptedJobsRead: (jobs: JobInfo[]) => {
    const next = markReadInterrupted(get().readInterrupted, jobs);
    if (next === get().readInterrupted) return;
    set({ readInterrupted: next });
    saveReadInterruptedJobs(next);
  },

  initEventListener: () => {
    const handleJobEvent = (raw: Record<string, unknown>) => {
      if (!raw) return;
      get().upsertJob(mapJob(raw));
    };

    // 同一事件名共享一条底层监听；取消订阅是同步返回的，所以 StrictMode 的
    // 「挂载 → 卸载 → 再挂载」不会重复注册（旧写法把 unlisten 推进数组、在
    // Promise resolve 之后才 push，先 detach 后 resolve 就会漏掉两个监听器）。
    const offStarted = subscribeTauriEvent<Record<string, unknown>>(
      'job://started',
      handleJobEvent,
    );
    const offUpdated = subscribeTauriEvent<Record<string, unknown>>(
      'job://updated',
      handleJobEvent,
    );

    return () => {
      offStarted();
      offUpdated();
    };
  },
}));
