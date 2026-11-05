import { useMemo } from 'react';
import { useConversationStore } from '@/stores/conversationStore';
import { backToParentThread } from '@/lib/subagentNav';
import { pendingAskParent } from '@/lib/subagentThread';
import type { AgentMessage } from '@/lib/types';

/**
 * 子对话底部的细条：子 agent 正停在 `ask_parent` 上等主 agent 回答。
 * 「回到主对话」打开父对话并落到这个子 agent 的时间线卡（走统一的 messageJumpStore 通路）。
 *
 * 只在「确有一次未回答的提问、且这是个子对话」时出现；回答一到（或用户在这之后又开了新回合）
 * 就消失。桌面手机共用同一个组件，由 `AgentTranscript` 挂在消息流末尾。
 */
export default function SubagentAwaitingNotice({
  conversationId,
  messages,
  mobile = false,
}: {
  conversationId: string;
  messages: readonly AgentMessage[];
  mobile?: boolean;
}) {
  const parentId = useConversationStore((s) => s.conversations[conversationId]?.parentConversationId);
  const pending = useMemo(() => (parentId ? pendingAskParent(messages) : null), [parentId, messages]);
  if (!parentId || !pending) return null;
  return (
    <div
      role="status"
      data-testid="subagent-awaiting-notice"
      className="my-1 flex min-w-0 items-center gap-2 rounded-lg border border-edge bg-zinc-800/50 px-3 py-1.5 text-[12px] text-zinc-400"
    >
      <span className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-zinc-500 motion-reduce:animate-none" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">正在等待主 Agent 回答</span>
      <button
        type="button"
        onClick={() => void backToParentThread(parentId, conversationId)}
        className={`flex-shrink-0 rounded-md font-medium text-zinc-300 transition-colors ${
          mobile ? 'px-2 py-1.5 active:bg-state-mid' : 'px-2 py-0.5 hover:bg-state-mid hover:text-zinc-100'
        }`}
      >
        回到主对话
      </button>
    </div>
  );
}
