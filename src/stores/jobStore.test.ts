import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useJobStore } from '@/stores/jobStore';

const { jobList } = vi.hoisted(() => ({
  jobList: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({
  jobList,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

/** 构造一条后端 JobInfo（snake_case，模拟 Tauri IPC 返回）。 */
function rawJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    job_id: 'job_1',
    session_id: 'sess_1',
    task_id: null,
    description: 'build',
    command: 'cargo build',
    status: 'running',
    started_at_millis: 1000,
    finished_at_millis: null,
    total_output_bytes: 0,
    ...overrides,
  };
}

describe('jobStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useJobStore.setState({ jobs: {} });
  });

  it('fetchJobs merges fetched jobs into store', async () => {
    jobList.mockResolvedValue([
      rawJob({ job_id: 'job_1', status: 'running' }),
      rawJob({ job_id: 'job_2', status: 'completed' }),
    ]);

    await useJobStore.getState().fetchJobs();

    expect(jobList).toHaveBeenCalledWith(null, null);
    const jobs = useJobStore.getState().jobs;
    expect(Object.keys(jobs).sort()).toEqual(['job_1', 'job_2']);
    expect(jobs.job_1.status).toBe('running');
    expect(jobs.job_2.status).toBe('completed');
  });

  it('fetchJobs with sessionId passes it through', async () => {
    jobList.mockResolvedValue([rawJob({ job_id: 'job_1', session_id: 'sess_9' })]);

    await useJobStore.getState().fetchJobs('sess_9');

    expect(jobList).toHaveBeenCalledWith('sess_9', null);
  });

  it('fetchJobs merges without dropping jobs already in store', async () => {
    // 事件已带来 job_9（拉取前存在）
    useJobStore.getState().upsertJob({
      jobId: 'job_9',
      sessionId: 'sess_1',
      taskId: null,
      description: 'other',
      command: 'echo hi',
      status: 'running',
      startedAtMillis: 9000,
      finishedAtMillis: null,
      totalOutputBytes: 3,
    });

    // 拉取返回 job_1 —— job_9 必须保留（合并而非整体替换）
    jobList.mockResolvedValue([rawJob({ job_id: 'job_1', status: 'running' })]);

    await useJobStore.getState().fetchJobs();

    const jobs = useJobStore.getState().jobs;
    expect(jobs.job_1).toBeDefined();
    expect(jobs.job_9.status).toBe('running');
  });

  it('event arriving after fetch overrides fetched state (event is newer)', async () => {
    jobList.mockResolvedValue([rawJob({ job_id: 'job_1', status: 'running' })]);
    await useJobStore.getState().fetchJobs();
    expect(useJobStore.getState().jobs.job_1.status).toBe('running');

    // 事件（后端结算后发出）到达 → 覆盖为 completed
    useJobStore.getState().upsertJob({
      jobId: 'job_1',
      sessionId: 'sess_1',
      taskId: null,
      description: 'build',
      command: 'cargo build',
      status: 'completed',
      startedAtMillis: 1000,
      finishedAtMillis: 2000,
      totalOutputBytes: 42,
    });

    expect(useJobStore.getState().jobs.job_1.status).toBe('completed');
  });

  it('fetchJobs swallows errors (does not throw)', async () => {
    jobList.mockRejectedValue(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(useJobStore.getState().fetchJobs()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    expect(useJobStore.getState().jobs).toEqual({});
    warn.mockRestore();
  });

  it('fetchJobs tolerates non-array response', async () => {
    jobList.mockResolvedValue(null);

    await useJobStore.getState().fetchJobs();

    expect(useJobStore.getState().jobs).toEqual({});
  });
});
