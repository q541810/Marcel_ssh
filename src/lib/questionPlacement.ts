/**
 * questionPlacement.ts —— 提问放哪儿：「内联卡片」还是「全局浮层」。
 *
 * 唯一的判定处。规则只有一条：这条提问所属的对话，此刻正显示在某个可见的 Agent
 * 对话面板里（桌面：面板开着且正显示它；手机：智能助手页正显示它）→ 内联在消息流
 * 末尾，用户一眼就能看到上文；否则（在终端 / 文件页、看着别的对话、面板收起）→ 全局
 * 浮层 / 胶囊提醒。审批不走这里，永远是全局浮层。
 *
 * 「可见」的事实来源是 `visibleTranscriptStore`（每个真正渲染着消息流的面板登记自己），
 * 内联卡片和全局浮层读同一份，所以同一条提问不会两边同时出现，也不会两边都不出现。
 */
import type { ActiveInteractionPayload } from '@/lib/types';

export function shouldShowQuestionInline(
  interaction: Pick<ActiveInteractionPayload, 'kind' | 'conversationId' | 'question'> | null | undefined,
  visibleConversationIds: ReadonlySet<string> | readonly string[],
): boolean {
  if (!interaction || interaction.kind !== 'question' || !interaction.question) return false;
  const id = interaction.conversationId;
  if (!id) return false;
  return Array.isArray(visibleConversationIds)
    ? visibleConversationIds.includes(id)
    : (visibleConversationIds as ReadonlySet<string>).has(id);
}
