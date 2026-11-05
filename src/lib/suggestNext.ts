/**
 * suggestNext.ts —— 「小建议卡片」（后端 `suggest_next` 工具）的前端纯逻辑。
 *
 * 卡片不阻塞 agent：工具调用立刻返回、本轮结束；用户点选项 = 发一条普通的用户消息，
 * 消息的 `userInput.replyTo` 记着「回的是哪次调用」。所以卡片没有任何待答状态，
 * 是否还能点完全由对话内容推出：这次调用之后，用户有没有发过话。
 */
import type { AgentMessage } from '@/lib/types';
import { validateUserInput } from '@/lib/userInput';

export const SUGGEST_NEXT_TOOL = 'suggest_next';

export interface Suggestion {
  readonly question: string;
  readonly options: readonly string[];
}

/** 从工具参数读出问题与选项（后端已校验；这里对历史 / 异常数据再兜一次底）。 */
export function parseSuggestion(args: Record<string, unknown> | undefined): Suggestion | null {
  const question = typeof args?.question === 'string' ? args.question.trim() : '';
  const raw = args?.options;
  if (!question || !Array.isArray(raw)) return null;
  const options = raw
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean);
  return options.length > 0 ? { question, options } : null;
}

/**
 * 这张卡片此刻的状态：
 * - `active`：这次调用之后用户没再说过话，还能点；
 * - `answered`：之后有一条用户消息正是对它的回信（那条气泡自己带着引用，卡片不再重复）；
 * - `expired`：用户之后自己打了别的字，建议过期。
 * 只看这次调用**之后**的用户消息（`notice` 是系统告知，不算用户说话）。
 */
export type SuggestionState = 'active' | 'answered' | 'expired';

export function suggestionState(
  messages: readonly AgentMessage[],
  toolCallId: string,
): SuggestionState {
  let at = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'tool' && messages[i].toolResult?.toolCallId === toolCallId) {
      at = i;
      break;
    }
  }
  if (at < 0) return 'active';
  let state: SuggestionState = 'active';
  for (let i = at + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const reply = validateUserInput(m.content, m.userInput)?.replyTo;
    if (reply?.toolCallId === toolCallId) return 'answered';
    state = 'expired';
  }
  return state;
}
