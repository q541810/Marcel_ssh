/**
 * questionJump.ts —— 「提问 → 提问前那段结论」的结构定位（纯函数，无副作用）。
 *
 * 两层定位，全部结构化，**从不拿问题文字去搜**：
 * 1. 消息：发出 `ask_user` 调用的那条 assistant 消息，它的正文就是目标文本。
 *    - 重载 / 落库后：assistant 消息自带 `toolCalls`，按调用 id 反查；
 *    - live 阶段：assistant 消息不带 `toolCalls`，改由 tool 消息上的
 *      `callerMessageId`（流式处理器在 toolCallStart 时记下）指回它。
 * 2. 正文内：问题可带 `anchor`（后端已校验、归一化过的小标题原文），在渲染出的
 *    DOM 里找归一化后相等的标题；找不到就退回正文开头。
 *
 * 归一化口径与后端 `question.rs::normalize_heading` 逐字一致：两边必须同步改。
 */
import type { AgentMessage } from '@/lib/types';

/** 小标题 / anchor 的统一归一化（后端 `normalize_heading` 的镜像）。 */
export function normalizeHeadingText(text: string): string {
  return text
    .replace(/[*_`]/g, '')
    .trim()
    .replace(/[:：]+$/, '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

/**
 * 这个元素是不是「小标题」：h1–h6，或者「整段只有一个加粗」的段落
 * （加粗外面允许跟一个 `:` / `：`）。与后端提取小标题的口径对应。
 */
export function isHeadingLike(el: Element): boolean {
  if (HEADING_TAGS.has(el.tagName)) return true;
  if (el.tagName !== 'P') return false;
  let strong = 0;
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3) {
      // 文本节点：只允许空白和结尾冒号
      if ((node.textContent ?? '').replace(/[\s:：]/g, '') !== '') return false;
    } else if (node.nodeType === 1) {
      const tag = (node as Element).tagName;
      if (tag !== 'STRONG' && tag !== 'B') return false;
      strong += 1;
    } else {
      return false;
    }
  }
  return strong === 1;
}

/** 在渲染出的正文里找 anchor 对应的小标题；找不到返回 null（调用方退回正文开头）。 */
export function findAnchorHeading(root: ParentNode, anchor: string | undefined): HTMLElement | null {
  const want = anchor ? normalizeHeadingText(anchor) : '';
  if (!want) return null;
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,p'))) {
    if (isHeadingLike(el) && normalizeHeadingText(el.textContent ?? '') === want) return el;
  }
  return null;
}

/** 消息有没有可跳的正文。 */
function hasText(message: AgentMessage | undefined): message is AgentMessage {
  return !!message && message.role === 'assistant' && message.content.trim() !== '';
}

/**
 * 找发出 `toolCallId` 这次调用的 assistant 消息，**且它有正文**才返回
 * （没有正文就没有可跳的东西，调用方据此不渲染跳转按钮）。
 */
export function resolveQuestionTextMessage(
  messages: readonly AgentMessage[],
  toolCallId: string,
): AgentMessage | null {
  if (!toolCallId) return null;
  const issuer = messages.find(
    (m) =>
      m.role === 'assistant' &&
      (m.toolCalls?.some((c) => c.id === toolCallId) || m.toolCall?.id === toolCallId),
  );
  if (issuer) return hasText(issuer) ? issuer : null;
  const tool = messages.find((m) => m.role === 'tool' && m.toolResult?.toolCallId === toolCallId);
  if (!tool?.callerMessageId) return null;
  const caller = messages.find((m) => m.id === tool.callerMessageId);
  return hasText(caller) ? caller : null;
}

/** 前端 live id 与库 id 是两个域：同一条消息两个 id 任一相等都算命中（`dbId ?? id` 口径）。 */
export function messageMatchesId(message: AgentMessage, id: string): boolean {
  return message.id === id || message.dbId === id;
}

/** 跳转请求能否落地的结果：消息已解析到，或者没有可跳的正文。 */
export interface QuestionJumpTarget {
  /** 目标消息（当前 live 列表里的那条）。 */
  readonly message: AgentMessage;
  /** 要对准的小标题（归一化过）；缺省 = 正文开头。 */
  readonly anchor?: string;
}

export function resolveQuestionJump(
  messages: readonly AgentMessage[],
  toolCallId: string,
  anchor?: string,
): QuestionJumpTarget | null {
  const message = resolveQuestionTextMessage(messages, toolCallId);
  if (!message) return null;
  const normalized = anchor ? normalizeHeadingText(anchor) : '';
  return normalized ? { message, anchor: normalized } : { message };
}
