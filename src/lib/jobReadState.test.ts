// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  READ_INTERRUPTED_JOBS_STORAGE_KEY,
  loadReadInterruptedJobs,
  markInterruptedJobsRead,
  saveReadInterruptedJobs,
} from '@/lib/jobReadState';
import type { JobInfo } from '@/lib/types';

const DAY = 24 * 60 * 60 * 1000;

const mockJob = (overrides: Partial<JobInfo> = {}): JobInfo => ({
  jobId: 'job_1',
  sessionId: 'session-1',
  description: 'npm run build',
  command: 'npm run build',
  status: 'interrupted',
  startedAtMillis: 1_000,
  totalOutputBytes: 0,
  ...overrides,
});

afterEach(() => {
  localStorage.clear();
});

describe('loadReadInterruptedJobs / saveReadInterruptedJobs', () => {
  it('空存储返回空表', () => {
    expect(loadReadInterruptedJobs()).toEqual({});
  });

  it('save → load 往返一致（双端共用同一份 localStorage）', () => {
    const now = Date.now();
    saveReadInterruptedJobs({ job_1: now });
    expect(loadReadInterruptedJobs(now)).toEqual({ job_1: now });
    expect(JSON.parse(localStorage.getItem(READ_INTERRUPTED_JOBS_STORAGE_KEY)!)).toEqual({
      job_1: now,
    });
  });

  it('存储损坏（坏 JSON / 非对象）时降级为空表，不抛错', () => {
    localStorage.setItem(READ_INTERRUPTED_JOBS_STORAGE_KEY, 'not json');
    expect(loadReadInterruptedJobs()).toEqual({});
    localStorage.setItem(READ_INTERRUPTED_JOBS_STORAGE_KEY, '5');
    expect(loadReadInterruptedJobs()).toEqual({});
  });

  it('加载时修剪超期条目（台账 7 天保留期后作业不可能再回来）', () => {
    localStorage.setItem(
      READ_INTERRUPTED_JOBS_STORAGE_KEY,
      JSON.stringify({ job_old: 0, job_new: 10 * DAY }),
    );
    // now = 8.5 天：job_old 超过 8 天保留期被丢，job_new 还在
    expect(loadReadInterruptedJobs(8.5 * DAY)).toEqual({ job_new: 10 * DAY });
  });
});

describe('markInterruptedJobsRead（纯函数）', () => {
  it('只把 interrupted 记进已读表，completed / failed / killed 不记', () => {
    const next = markInterruptedJobsRead(
      {},
      [
        mockJob({ jobId: 'job_1' }),
        mockJob({ jobId: 'job_2', status: 'completed' }),
        mockJob({ jobId: 'job_3', status: 'failed' }),
        mockJob({ jobId: 'job_4', status: 'killed' }),
      ],
      2_000,
    );
    expect(next).toEqual({ job_1: 1_000 });
  });

  it('已记过的作业不重复记（保持 startedAt 原值）', () => {
    const prev = { job_1: 1_000 };
    const next = markInterruptedJobsRead(
      prev,
      [mockJob({ jobId: 'job_1', startedAtMillis: 9_999 })],
      2_000,
    );
    expect(next).toBe(prev);
  });

  it('没有新记账时原样返回 prev（调用方据此跳过 store 更新与回写）', () => {
    const prev = { job_1: 1_000 };
    expect(
      markInterruptedJobsRead(prev, [mockJob({ jobId: 'job_1' }), mockJob({ jobId: 'job_2', status: 'completed' })], 2_000),
    ).toBe(prev);
  });

  it('记账顺手修剪超期旧条目', () => {
    const prev = { job_old: 0 };
    const next = markInterruptedJobsRead(
      prev,
      [mockJob({ jobId: 'job_new', startedAtMillis: 9 * DAY })],
      9 * DAY,
    );
    expect(next).toEqual({ job_new: 9 * DAY });
  });

  it('空 jobId 不记账（防御 mapJob 缺字段的退化值）', () => {
    expect(markInterruptedJobsRead({}, [mockJob({ jobId: '' })], 2_000)).toEqual({});
  });
});
