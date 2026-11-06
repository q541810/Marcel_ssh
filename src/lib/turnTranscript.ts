/**
 * turnTranscript.ts — 「一个任务（回合）」的收尾信息与可复制文本。
 *
 * 一个任务 = 相邻两条回合起点（user / notice）之间的消息，口径与回合折叠
 * （`agentTurnFold`）完全一致，这里直接复用它的分段，不另起一套边界。
 *
 * 三件事，全是纯函数（便于单测，桌面与移动端共用同一份）：
 * - {@link turnFooters}：哪几个任务已经结束、「复制 / 用时」条挂在哪条消息下面；
 * - {@link turnElapsedMs}：任务用时；
 * - {@link buildTurnTranscript}：整个任务的可复制文本（含工具调用与返回，**不含**
 *   模型思维链）。
 */

import type { AgentMessage, ToolCallInfo } from '@/lib/types';
import { isTurnStart, segmentTurns } from '@/lib/agentTurnFold';
import { validateUserInput } from '@/lib/userInput';
import { SUGGEST_NEXT_TOOL } from '@/lib/suggestNext';

/** 一个已结束任务的收尾条信息（按「挂在哪条消息下面」索引）。 */
export interface TurnFooter {
  /** 条挂在这条消息下面（任务里模型说的最后一段话）。 */
  readonly messageId: string;
  /** 整个任务的消息（含开头的 user）。复制整个任务时用它。 */
  readonly turn: readonly AgentMessage[];
  /** 任务用时；算不出来（时间戳缺失 / 倒挂）为 `null`，界面不显示用时。 */
  readonly elapsedMs: number | null;
}

/** 这条消息是不是「模型对用户说的一段话」：有正文的 assistant（思考中的骨架不算）。 */
function isModelReply(message: AgentMessage): boolean {
  return message.role === 'assistant' && !message.isLoading && message.content.trim().length > 0;
}

/**
 * 找出每个**已结束**任务里「模型说的最后一段话」，收尾条挂在它下面。
 *
 * 不挂条的情形（宁缺毋滥 —— 条上的「用时」只对结束了的任务成立）：
 * - 任务还在跑：尾回合且 `tailActive`，或回合里还有执行中 / 加载中的消息；
 * - 回合收尾状态是 `running`：上次进程崩溃留下的半截回合，没有可信的终点；
 * - 任务不是以文字结束的（最后一段话之后还跟着工具消息 —— 比如在一次工具调用
 *   中途被停止）：此时那段话并不是「最后一条消息」，挂在它下面会夹在工具卡中间。
 *   **`suggest_next` 除外**：小建议卡片的调用和结论在同一条消息里，它的结果（那张卡片）
 *   跟在结论后面，不是「被打断」，而是任务正常的收尾；
 * - 回合里模型一句话都没说。
 */
export function turnFooters(
  messages: readonly AgentMessage[],
  opts: { tailActive: boolean },
): Map<string, TurnFooter> {
  const footers = new Map<string, TurnFooter>();
  const segments = segmentTurns(messages, { tailActive: opts.tailActive });
  segments.forEach((segment, index) => {
    const turn = segment.messages;
    if (turn.length === 0 || !isTurnStart(turn[0])) return;
    const isTail = index === segments.length - 1;
    if (isTail && opts.tailActive) return;
    if (turn[0].turnState === 'running') return;
    if (turn.some((m) => m.isExecuting || m.isLoading)) return;

    let target = -1;
    for (let i = turn.length - 1; i >= 0; i -= 1) {
      if (isModelReply(turn[i])) {
        target = i;
        break;
      }
    }
    if (target < 0) return;
    if (turn.slice(target + 1).some((m) => m.role === 'tool' && m.toolResult?.toolName !== SUGGEST_NEXT_TOOL)) return;

    footers.set(turn[target].id, {
      messageId: turn[target].id,
      turn,
      elapsedMs: turnElapsedMs(turn),
    });
  });
  return footers;
}

/**
 * 任务用时（毫秒）：回合起点的发送时间 → 任务结束的时间。
 *
 * 终点有两个来源，live 优先：
 * 1. 锚点消息上的 `turnFinishedAt` —— 前端在收到结束信号的那一刻记下的（见
 *    `markTailTurnState`）。live 阶段必须靠它：assistant 消息的 `timestamp` 是
 *    **开始流式输出**的时刻，拿它当终点会把最后一段话的输出时间漏掉；
 * 2. 回合里最后一条消息的 `timestamp` —— 重载后走这条：后端落库的时间戳是消息
 *    写入的时刻（流式结束之后），与 live 的终点只差毫秒。
 *
 * 等待审批的时间算在内：这里的「用时」是从发出到结束的墙钟时间，与用户感知一致。
 */
export function turnElapsedMs(turn: readonly AgentMessage[]): number | null {
  const anchor = turn[0];
  if (!anchor) return null;
  const start = Date.parse(anchor.timestamp);
  if (!Number.isFinite(start)) return null;

  let end = anchor.turnFinishedAt ? Date.parse(anchor.turnFinishedAt) : Number.NaN;
  if (!Number.isFinite(end)) {
    end = Number.NaN;
    for (let i = turn.length - 1; i > 0; i -= 1) {
      // system 消息（压缩卡、重试提示）的时间不代表任务的终点
      if (turn[i].role === 'system') continue;
      end = Date.parse(turn[i].timestamp);
      break;
    }
  }
  if (!Number.isFinite(end) || end < start) return null;
  return end - start;
}

/** 用时的人话写法：`不到 1 秒` / `42 秒` / `2 分 14 秒` / `1 小时 5 分`。 */
export function formatTurnElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 1) return '不到 1 秒';
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes} 分 ${totalSeconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

/**
 * 用代码围栏包住内容。围栏长度取「内容里最长的反引号连续段 + 1」（至少 3）：
 * 工具输出里完全可能带 ``` ，固定三个反引号会让围栏提前闭合、后面的内容散架。
 */
function fenced(content: string, lang = ''): string {
  let longest = 0;
  for (const run of content.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${content}\n${fence}`;
}

function formatArguments(args: Record<string, unknown> | undefined): string {
  if (!args || Object.keys(args).length === 0) return '{}';
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function userSection(message: AgentMessage): string {
  const input = validateUserInput(message.content, message.userInput);
  // 附件的文件正文是给模型的输入，不是用户打的字：这里只写文字与附件名，
  // 否则复制出来的「用户」段会被整份文件撑爆。
  const text = (input ? input.text : message.content).trim();
  const lines: string[] = [];
  if (input?.replyTo) lines.push(`（回复建议卡片：${input.replyTo.question}）`);
  if (text) lines.push(text);
  const names = input?.textAttachments.map((file) => file.name) ?? [];
  if (names.length > 0) lines.push(`（附件：${names.join('、')}）`);
  const skillNames = input?.skills?.map((skill) => skill.name) ?? [];
  if (skillNames.length > 0) lines.push(`（引用 skill：${skillNames.join('、')}）`);
  const images = message.imagePaths?.length ?? 0;
  if (images > 0) lines.push(`（图片 ${images} 张）`);
  return `**用户**\n\n${lines.join('\n') || '（空）'}`;
}

function toolOutcomeNote(result: NonNullable<AgentMessage['toolResult']>): string {
  if (result.blocked) return '（已被拦截）';
  if (result.wasTimeout) return '（超时）';
  if (result.wasAborted) return '（已中止）';
  if (!result.success) return '（失败）';
  return '';
}

function callSection(name: string, args: Record<string, unknown> | undefined): string {
  return `**工具调用 · ${name}**\n\n${fenced(formatArguments(args), 'json')}`;
}

/**
 * 整个任务的可复制文本（Markdown）：用户的话 → 模型的话 → 每次工具调用与它的返回，
 * 按发生顺序排。
 *
 * **不含模型思维链**（`reasoningContent`）；压缩卡、重试提示这类系统消息也不含 ——
 * 它们是界面上的过程提示，不是对话本身。
 *
 * 工具调用 / 返回以 `role: 'tool'` 的消息为准（有名字、参数、结果）；assistant 消息
 * 上挂的 `toolCalls` 只用来补「发出了调用但没有返回」的那几次（比如中途被停止），
 * 以 `toolCallId` 对账，不会重复出现。
 */
export function buildTurnTranscript(turn: readonly AgentMessage[]): string {
  const answered = new Set<string>();
  for (const message of turn) {
    const id = message.role === 'tool' ? message.toolResult?.toolCallId : undefined;
    if (id) answered.add(id);
  }

  const sections: string[] = [];
  for (const message of turn) {
    switch (message.role) {
      case 'user':
        sections.push(userSection(message));
        break;
      case 'notice': {
        const text = message.content.trim();
        if (text) sections.push(`**系统告知**\n\n${text}`);
        break;
      }
      case 'assistant': {
        if (message.isLoading) break;
        const text = message.content.trim();
        if (text) sections.push(`**助手**\n\n${text}`);
        const calls: ToolCallInfo[] = message.toolCalls?.length
          ? message.toolCalls
          : message.toolCall
            ? [message.toolCall]
            : [];
        for (const call of calls) {
          if (answered.has(call.id)) continue;
          sections.push(`${callSection(call.name, call.arguments)}\n\n（没有返回结果）`);
        }
        break;
      }
      case 'tool': {
        const result = message.toolResult;
        if (!result || message.isExecuting) break;
        sections.push(callSection(result.toolName, result.arguments));
        const note = toolOutcomeNote(result);
        sections.push(
          `**工具返回 · ${result.toolName}**${note}\n\n${fenced(result.result)}`,
        );
        break;
      }
      case 'system':
        break;
    }
  }
  return sections.join('\n\n');
}
