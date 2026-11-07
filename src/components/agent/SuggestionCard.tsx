import { memo, useContext, useState } from 'react';
import { collectPlatformHints, isMobilePlatform } from '@/platform';
import { useConversationStore } from '@/stores/conversationStore';
import { useTaskStore } from '@/stores/taskStore';
import { useSessionStore } from '@/stores/sessionStore';
import { sessionConversationBindingManager } from '@/stores/sessionConversationBindingManager';
import { isTaskBusy } from '@/lib/agentStatus';
import { getErrorMessage } from '@/lib/errors';
import { parseSuggestion, suggestionState } from '@/lib/suggestNext';
import { MessageJumpContext } from './messageJumpContext';
import type { ToolViewProps } from './toolViews';

/** 点选项：把它当作一条对这次调用的回信发出去（与用户自己打字发送走同一个 startTask）。 */
async function sendReply(
  conversationId: string,
  toolCallId: string,
  question: string,
  text: string,
): Promise<void> {
  const bound = sessionConversationBindingManager.findOccupyingSession(conversationId);
  if (!bound || bound.session.status !== 'connected') {
    throw new Error('这台机器已断开，连上后再点');
  }
  await useTaskStore.getState().startTask(
    bound.sessionId,
    text,
    bound.session.configId ?? bound.session.connectionId,
    [],
    [],
    {
      conversationId,
      userInput: { version: 1, text, textAttachments: [], replyTo: { toolCallId, question } },
    },
  );
}

/**
 * `suggest_next` 的小建议卡片（注册在 toolViews，两端共用）：任务做完后贴在结论下面的
 * 一句话问题 + 几个编号选项。刻意做小：字小、只有内容那么宽、没有输入框 / 跳过 / 彩色，
 * 用户有自己的输入框；完全不碰输入框和焦点，可以直接无视它继续打字。
 * 点选项 = 发一条带「回信指向这次调用」标记的普通消息；之后卡片自己消失（那条用户气泡
 * 带着引用，就是记录）。用户自己打了别的字，卡片同样消失。
 */
function SuggestionCard({ message }: ToolViewProps) {
  const tr = message.toolResult;
  const toolCallId = tr?.toolCallId ?? '';
  const conversationId = useContext(MessageJumpContext)?.conversationId ?? null;
  const state = useConversationStore((s) =>
    conversationId ? suggestionState(s.messages[conversationId] ?? [], toolCallId) : 'expired',
  );
  const busy = useTaskStore(
    (s) =>
      !!conversationId &&
      (!!s.compacting[conversationId] ||
        Object.values(s.tasks).some(
          (t) => t.conversationId === conversationId && !!t.sessionId && isTaskBusy(t.status),
        )),
  );
  // 订阅会话表只为「断开 / 重连」时重算一次；真正的绑定关系每次点击时再查
  const sessions = useSessionStore((s) => s.sessions);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suggestion = parseSuggestion(tr?.arguments);
  if (!suggestion || !conversationId || state !== 'active') return null;
  if (message.isExecuting || message.isComposing || tr?.success === false) return null;
  const mobile = isMobilePlatform(collectPlatformHints());
  const occupying = sessionConversationBindingManager.findOccupyingSession(conversationId);
  const connected = !!occupying && sessions[occupying.sessionId]?.status === 'connected';
  const disabled = busy || sending || !connected;

  const pick = async (text: string) => {
    if (disabled) return;
    setSending(true);
    setError(null);
    try {
      await sendReply(conversationId, toolCallId, suggestion.question, text);
    } catch (e) {
      setError(getErrorMessage(e));
      setSending(false);
    }
  };

  return (
    <div
      data-testid="suggestion-card"
      className="my-2 w-fit max-w-full rounded-xl bg-surface-raised px-3 py-2 text-body leading-5 animate-fadeIn"
    >
      <div className="text-fg">{suggestion.question}</div>
      <ol className="mt-1 space-y-px">
        {suggestion.options.map((option, index) => (
          <li key={`${index}:${option}`}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => void pick(option)}
              className={`flex w-full min-w-0 items-baseline gap-1.5 rounded-md px-1.5 text-left text-fg transition-colors ${
                mobile ? 'min-h-9 py-1.5 active:bg-state-soft' : 'py-0.5 hover:bg-state-soft hover:text-fg'
              } ${disabled ? 'cursor-default opacity-60' : ''}`}
            >
              <span className="flex-shrink-0 text-fg-tertiary">{index + 1}.</span>
              <span className="min-w-0 [overflow-wrap:anywhere]">{option}</span>
            </button>
          </li>
        ))}
      </ol>
      {error && <div className="mt-1 px-1.5 text-meta text-fg-tertiary">没发出去：{error}</div>}
    </div>
  );
}

export default memo(SuggestionCard) as (props: ToolViewProps) => JSX.Element | null;
