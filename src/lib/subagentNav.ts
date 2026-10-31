/**
 * subagentNav.ts —— 主对话 ⇄ 子对话之间的跳转入口（桌面手机共用）。
 *
 * 全部走统一的 `openConversation` + `messageJumpStore` 单一跳转通路：先把对话切过来，
 * 再提交一条跳转请求，由持有那条对话消息流的 `AgentTranscript` 在它显示出来后执行
 * （请求带过期时间，对话还没载入完也不会丢）。
 *
 * 绑定管理器连着终端 / 会话一大串依赖，消息卡片的渲染路径不该静态背上它，所以动态 import。
 */
import type { AgentMessage, SubagentQuestionSource } from './types';
import { isAskParentTool } from './toolCatalog';
import { requestSubagentThreadJump, requestToolCallJump } from '@/stores/messageJumpStore';

async function openConversation(conversationId: string): Promise<void> {
  const m = await import('@/stores/sessionConversationBindingManager');
  await m.sessionConversationBindingManager.openConversation(conversationId);
}

/** 打开子对话（不跳转具体位置）。 */
export async function openSubConversation(subConversationId: string): Promise<void> {
  if (!subConversationId) return;
  await openConversation(subConversationId);
}

/** 「查看它的上下文」：打开子对话，并落到它那次 ask_parent 调用上。 */
export async function openSubagentQuestionContext(source: SubagentQuestionSource): Promise<void> {
  await openConversation(source.conversationId);
  if (source.askToolCallId) requestToolCallJump(source.conversationId, source.askToolCallId);
}

/** 「回到主对话」：打开父对话，并落到这个子 agent 的时间线卡上。 */
export async function backToParentThread(parentConversationId: string, subConversationId: string): Promise<void> {
  await openConversation(parentConversationId);
  requestSubagentThreadJump(parentConversationId, subConversationId);
}

/** 子对话标题去掉登记时加的「（子agent）」后缀，用在「来自子 Agent「…」」这类句子里。 */
export function subagentDisplayTitle(title: string): string {
  const t = title.replace(/（子agent）$/i, '').trim();
  return t || '子 Agent';
}

/**
 * 从 ask_user 的调用参数里读 `source_subagent`（历史回放时 QuestionRecord 用）。
 * 参数形状是**子对话 id 字符串**（即子 agent 提问结果里给出的 continue_id）；兼容对象写法。
 * 只返回 id —— 标题和那次 ask_parent 调用 id 参数里没有，由调用方按 id 去会话 store 里补
 * （`completeQuestionSource`）。
 */
export function readSourceSubagentId(args: Record<string, unknown> | undefined): string {
  const raw = args?.source_subagent ?? args?.sourceSubagent;
  if (typeof raw === 'string') return raw.trim();
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const v = o.conversation_id ?? o.conversationId;
    return typeof v === 'string' ? v.trim() : '';
  }
  return '';
}

/**
 * 用会话 store 里已有的东西补全来源：标题取子对话标题，ask_parent 调用 id 取子对话里最后一次提问。
 * 子对话没加载时 askToolCallId 为空串 —— 「查看它的上下文」仍能打开子对话，只是不跳到具体位置。
 */
export function completeQuestionSource(
  conversationId: string,
  title: string | undefined,
  subMessages: readonly AgentMessage[] | undefined,
): SubagentQuestionSource {
  let askToolCallId = '';
  for (let i = (subMessages?.length ?? 0) - 1; i >= 0; i -= 1) {
    const m = subMessages![i];
    const calls = m.toolCalls ?? (m.toolCall ? [m.toolCall] : []);
    const hit = [...calls].reverse().find((c) => isAskParentTool(c.name));
    if (hit) { askToolCallId = hit.id; break; }
    if (m.role === 'tool' && m.toolResult && isAskParentTool(m.toolResult.toolName) && m.toolResult.toolCallId) {
      askToolCallId = m.toolResult.toolCallId;
      break;
    }
  }
  return { conversationId, title: title ?? '', askToolCallId };
}
