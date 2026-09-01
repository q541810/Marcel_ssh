import { create } from 'zustand';
import type { JobInfo } from '@/lib/types';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getErrorMessage } from '@/lib/errors';
import * as tauri from '@/lib/tauri';

interface JobState {
  /** 全部已知作业（运行中 + 已完结），按 jobId 索引。 */
  jobs: Record<string, JobInfo>;
  /**
   * 拉取后台作业列表并合并进 store。
   * @param sessionId 会话 ID；空 / null = 拉取全部会话的作业（启动恢复用）。
   * 只 upsert 合并、绝不整体替换（避免回退事件已带来的更新状态）。
   * 拉取失败静默 warn，不 throw（best-effort，不阻塞启动/连接）。
   */
  fetchJobs: (sessionId?: string | null) => Promise<void>;
  killJob: (jobId: string) => Promise<void>;
  upsertJob: (job: JobInfo) => void;
  /** 监听后端 job://started / job://updated 事件；返回解绑函数。 */
  initEventListener: () => () => void;
}

/** 后端 JobInfo（snake_case serde）→ 前端 camelCase。 */
function mapJob(raw: Record<string, unknown>): JobInfo {
  return {
    jobId: String(raw.job_id ?? raw.jobId ?? ''),
    sessionId: String(raw.session_id ?? raw.sessionId ?? ''),
    taskId: raw.task_id != null ? String(raw.task_id) : null,
    description: String(raw.description ?? ''),
    command: String(raw.command ?? ''),
    status: (raw.status as JobInfo['status']) ?? 'running',
    startedAtMillis: Number(raw.started_at_millis ?? raw.startedAtMillis ?? Date.now()),
    finishedAtMillis:
      raw.finished_at_millis != null ? Number(raw.finished_at_millis) : null,
    totalOutputBytes: Number(raw.total_output_bytes ?? raw.totalOutputBytes ?? 0),
  };
}

export const useJobStore = create<JobState>((set, get) => ({
  jobs: {},

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

  initEventListener: () => {
    const unlisteners: Array<() => void> = [];

    const handleJobEvent = (raw: Record<string, unknown>) => {
      get().upsertJob(mapJob(raw));
    };

    listen<Record<string, unknown>>('job://started', (e) => {
      if (e.payload) handleJobEvent(e.payload);
    }).then((unlisten) => unlisteners.push(unlisten));

    listen<Record<string, unknown>>('job://updated', (e) => {
      if (e.payload) handleJobEvent(e.payload);
    }).then((unlisten) => unlisteners.push(unlisten));

    return () => {
      unlisteners.forEach((fn) => fn());
    };
  },
}));
