import { describe, it, expect } from 'vitest';
import type { JobStatus, JobOutputResult } from './types';

/**
 * 后端源码。用 vite 的 raw glob 读进来做文本比对（与 `turnState.test.ts` /
 * `disposition.test.ts` 同一手法：本仓库没装 @types/node，测试里不引 node API）。
 * - `job.rs`：`JobStatus` 枚举（变体名 / 序列化大小写）+ `JobInfo`/`JobOutputResult` 字段
 * - `ticket.rs`：`CancelReason` 枚举
 */
const RUST = import.meta.glob(
  ['/src-tauri/src/command_exec/job.rs', '/src-tauri/src/command_exec/ticket.rs'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

const jobSource = RUST['/src-tauri/src/command_exec/job.rs'] ?? '';
const ticketSource = RUST['/src-tauri/src/command_exec/ticket.rs'] ?? '';

/** 抽 `pub enum X { … }` 的头部与变体名（每个变体独占一行）。 */
function parseEnum(src: string, name: string): { header: string; variants: string[] } {
  const start = src.indexOf(`pub enum ${name} {`);
  expect(start, `${name} 在源码里找不到`).toBeGreaterThan(-1);
  const end = src.indexOf('\n}', start);
  const body = src.slice(start, end);
  const variants: string[] = [];
  for (const line of body.split('\n')) {
    const variant = line.match(/^\s{4}([A-Z][A-Za-z0-9]*),\s*$/);
    if (variant) variants.push(variant[1]);
  }
  const header = src.slice(Math.max(0, start - 220), start);
  return { header, variants };
}

/**
 * Rust 变体名 → 落线字符串：`#[serde(rename_all = "snake_case")]` 的转换。
 * 一个词直接小写（`Killed` → `killed`），多个词要插下划线
 * （`RuntimeRestart` → `runtime_restart`）——不能只 toLowerCase，否则多词
 * 变体会给出一个线上根本不存在的字符串，护栏就变成了自欺。
 */
function toSerdeSnake(variant: string): string {
  return variant.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** 前端作业状态清单（与 types.ts 的联合类型一一对应）。 */
const FRONTEND_JOB_STATUSES: JobStatus[] = [
  'running',
  'completed',
  'killed',
  'failed',
  'interrupted',
];

/** 前端取消来源清单（job_output 的 cancelReason）。 */
const FRONTEND_CANCEL_REASONS: NonNullable<JobOutputResult['cancelReason']>[] = [
  'user',
  'agent',
  'task',
  'disconnected',
  'runtime_restart',
];

describe('作业状态与后端枚举对齐', () => {
  const status = parseEnum(jobSource, 'JobStatus');
  const reason = parseEnum(ticketSource, 'CancelReason');

  it('后端源码能被解析到（防止 glob 路径写错后整组测试变成空转）', () => {
    expect(jobSource.length).toBeGreaterThan(0);
    expect(ticketSource.length).toBeGreaterThan(0);
    expect(status.variants.length).toBeGreaterThan(0);
    expect(reason.variants.length).toBeGreaterThan(0);
  });

  it('JobStatus 变体与前端清单逐一对应', () => {
    expect(status.variants.map(toSerdeSnake)).toEqual([...FRONTEND_JOB_STATUSES]);
  });

  it('CancelReason 变体与前端清单对应（含应用退出）', () => {
    expect(reason.variants.map(toSerdeSnake)).toEqual([...FRONTEND_CANCEL_REASONS]);
  });

  it('两侧枚举都确实按 snake_case 落线（前端清单的依据）', () => {
    // 变体名 → 线上字符串的转换规则变了（比如改成 camelCase），前端按
    // snake_case 写的匹配会静默失效，这里把规则本身钉住。
    expect(status.header).toContain('#[serde(rename_all = "snake_case")]');
    expect(reason.header).toContain('#[serde(rename_all = "snake_case")]');
  });

  it('JobOutputResult 的线名字段对得上（含 lossy / skipped_bytes / spill_path）', () => {
    // 这几个字段是「回读有没有丢内容」的全部依据：Rust 侧改名而前端没跟上，
    // 前端就会把「丢了内容」渲染成「一切正常」——修复等于没做。
    const start = jobSource.indexOf('pub struct JobOutputResult {');
    expect(start, 'job.rs 里找不到 JobOutputResult').toBeGreaterThan(-1);
    const body = jobSource.slice(start, jobSource.indexOf('\n}', start));
    for (const field of [
      'pub job_id:',
      'pub delta:',
      'pub offset:',
      'pub status:',
      'pub detail:',
      'pub cancel_reason:',
      'pub lossy:',
      'pub skipped_bytes:',
      'pub spill_path:',
    ]) {
      expect(body, `JobOutputResult 缺少字段 ${field}`).toContain(field);
    }
  });

  it('JobInfo 带上归属对话与结算细节（前端靠它们展示）', () => {
    const start = jobSource.indexOf('pub struct JobInfo {');
    expect(start, 'job.rs 里找不到 JobInfo').toBeGreaterThan(-1);
    const body = jobSource.slice(start, jobSource.indexOf('\n}', start));
    for (const field of ['pub owner_conversation_id:', 'pub detail:', 'pub status:']) {
      expect(body, `JobInfo 缺少字段 ${field}`).toContain(field);
    }
  });
});
