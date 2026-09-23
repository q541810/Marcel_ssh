/**
 * 后台作业跑完后的**自动继续**（对齐 DSH 的 `completionDelivery: 'wakeup'`）。
 *
 * 语义（这是这次改动的核心）：回合结束与作业无关 —— 模型给出结论、这一轮就
 * 收尾，还在跑的作业留在服务器上继续跑；作业结算时，如果那条会话此刻没人在
 * 跑，系统**自己开一轮**把「后台作业 xxx 已完成」交给模型，让它读输出、接着
 * 汇报。用户什么都不用做。
 *
 * 四条必须守住的规矩：
 * 1. **只对自然结束的作业叫醒**（完成 / 真正的执行失败）。被用户掐掉的、任务
 *    停止带走的、断连杀掉的、重启前留下的，都由后端过滤掉 —— 那些要么是用户
 *    自己干的，要么会话都没了，为它们开一轮只白花一次模型请求（DSH 的
 *    `reported` 同义）。
 * 2. **额度 3 次封顶**，且只由真的用户输入回填（见 `wakeBudget`）。
 * 3. **送不出去就不算已读**：拿到告知文本 → 开轮 → 成功后才向后端确认
 *    （`job_ack_notice`）。会话已关 / 连接断了 / 开轮失败时，结局仍留在后台，
 *    用户下次在那个会话开口时模型会知道。
 * 4. **不打扰用户正在做的事**：只给「当前没人在跑、会话消息已加载、SSH 连接
 *    还在」的会话开轮；开轮不抢 `activeTaskId`（见 `taskStore.startTask`），
 *    所以给别的会话自动继续不会影响用户正在看的会话。
 *
 * 触发时机（三个都要，缺一就有窗口）：
 * - `job://updated` 且作业终态 —— 常规路径；
 * - 某轮结束（Done / Cancelled / Failed）后 —— 关掉「作业恰好在回合收尾那一刻
 *   结算、两边都没接住」的竞态窗口；
 * - 移动端切回前台 —— 后台时 WebView 的 JS 会被冻结，事件在恢复后才补上。
 */

import * as tauri from '@/lib/tauri';
import { subscribeTauriEvent, type Unsubscribe } from '@/lib/tauriEvent';
import type { JobInfo } from '@/lib/types';
import {
  conversationHasRunningTask,
  useConversationStore,
} from './conversationStore';
import { useJobStore } from './jobStore';
import { useTaskStore } from './taskStore';
import { canAutoContinue, spendAutoContinue } from './wakeBudget';

/** 正在为某会话开轮（防同一条会话并发开出两轮）。 */
const waking = new Set<string>();

/** 作业是不是「跑完了」（还在跑就没有结局可交）。 */
function isSettled(job: JobInfo): boolean {
  return job.status !== 'running';
}

/**
 * 取某条会话的 SSH 会话状态（是否需要给它开轮）。
 *
 * **惰性 import**：`sessionStore` 静态引入了终端单例（`TerminalInstanceManager`），
 * 而 xterm 在 import 阶段就取 `self` —— 本模块被 `agentStreamManager` 静态引用，
 * 静态引 sessionStore 会把 xterm 拖进每一个 import 它们的测试文件的 import 图，
 * 在 node 环境下直接 `self is not defined`（实测：11 个测试文件加载失败）。
 * 这里用动态 import 把这条边留在运行时，代价是一次已缓存的模块解析。
 */
async function sessionIsConnected(sessionId: string): Promise<{
  connected: boolean;
  connectionId?: string;
}> {
  const { useSessionStore } = await import('./sessionStore');
  const session = useSessionStore.getState().sessions[sessionId];
  if (!session || session.status !== 'connected') return { connected: false };
  return { connected: true, connectionId: session.connectionId };
}

/**
 * 尝试为一条会话自动继续一轮。找不到可交付的结局、或上述四条规矩有任一条
 * 不满足时**啥也不做**（结局留在后台，等用户下次开口）。
 */
export async function maybeContinueForConversation(
  conversationId: string,
  sessionId: string,
): Promise<void> {
  if (!conversationId || !sessionId || waking.has(conversationId)) return;
  // 会话里已经有任务在跑（用户刚发过消息、或上一轮还没收尾）→ 那一边会把
  // 结局注入进去，这里不抢。
  if (conversationHasRunningTask(conversationId)) return;
  // 额度用尽 → 不再自动开轮（结局仍待播报）。
  if (!canAutoContinue(conversationId)) return;

  const conversationStore = useConversationStore.getState();
  const messages = conversationStore.messages[conversationId] ?? [];
  // 会话没在 store 里加载过 → 开了轮也没有历史（后端拿到的 history 是空
  // 的），模型会在没有上下文的情况下读一条作业告知。宁可不开：结局留着，
  // 用户下次进这条会话时再交给它。
  if (!conversationStore.conversations[conversationId] || messages.length === 0) return;

  const session = await sessionIsConnected(sessionId);
  if (!session.connected) return;

  let notice: tauri.JobNotice | null = null;
  try {
    notice = await tauri.jobPendingNotice(conversationId);
  } catch (err) {
    console.warn('[jobWake] 读取待播报作业结局失败', err);
    return;
  }
  if (!notice || !notice.text.trim()) return;

  waking.add(conversationId);
  try {
    await useTaskStore.getState().startTask(
      sessionId,
      notice.text,
      session.connectionId ?? '', 
      undefined,
      undefined,
      { conversationId, jobNotice: true },
    );
    // 真的开出去了才花额度、才确认已读。
    spendAutoContinue(conversationId);
    try {
      await tauri.jobAckNotice(notice.jobIds);
    } catch (err) {
      // 确认失败只会让这条结局**多播一次**（下次还可能被当成新结局）——
      // 比「静默吞掉」安全，如实记一笔即可。
      console.warn('[jobWake] 确认作业结局已读失败（可能重复告知）', err);
    }
  } catch (err) {
    // 开轮失败：不确认、不花额度 —— 结局仍待播报，用户下次开口时模型会知道。
    console.warn('[jobWake] 自动继续开轮失败，结局保留待播报', err);
  } finally {
    waking.delete(conversationId);
  }
}

/** 从一条作业事件里认出「哪条会话的作业跑完了」，并尝试自动继续。 */
function handleJobEvent(job: JobInfo): void {
  if (!isSettled(job)) return;
  const conversationId = job.ownerConversationId;
  if (!conversationId) return; // 无归属（旧记录 / 界面直接派发）→ 不唤醒
  void maybeContinueForConversation(conversationId, job.sessionId);
}

/**
 * 某会话的一轮刚结束（Done / Cancelled / Failed）时调一次。
 *
 * 「作业恰好在回合收尾那一刻结算、结算通知与 Done 各自错过」的窗口就是靠它
 * 关掉的：这里再看一眼有没有待播报的结局，有就开一轮。
 */
export function onTurnFinished(conversationId: string, taskId: string): void {
  const task = useTaskStore.getState().tasks[taskId];
  if (!conversationId || !task?.sessionId) return;
  void maybeContinueForConversation(conversationId, task.sessionId);
}

/** 移动端切回前台：对当前已知的、已跑完的作业各补一次检查（幂等）。 */
function sweepSettledJobs(): void {
  for (const job of Object.values(useJobStore.getState().jobs)) {
    handleJobEvent(job);
  }
}

/**
 * 挂上自动继续的监听（桌面与移动端各在 App 启动时调一次）。返回退订函数。
 */
export function initJobWake(): Unsubscribe {
  const unsubs: Unsubscribe[] = [
    subscribeTauriEvent<JobInfo>('job://updated', (payload) => {
      if (payload && typeof payload === 'object') handleJobEvent(payload);
    }),
  ];

  // 切回前台：后台时 JS 被冻结，`job://updated` 可能在恢复后才补上。
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('mobile:foreground', sweepSettledJobs);
    unsubs.push(() => window.removeEventListener('mobile:foreground', sweepSettledJobs));
  }

  return () => {
    for (const unsub of unsubs) unsub();
  };
}
