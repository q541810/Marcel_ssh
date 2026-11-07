import { Paperclip, Pencil, X } from "lucide-react";
import {
  EMPTY_QUEUE,
  queuePauseText,
  useAgentQueueStore,
  type QueuedMessage,
} from "@/stores/agentQueueStore";

interface Props {
  conversationId: string | null;
  mobile?: boolean;
  /** 消息被取回输入区之后（桌面用来把焦点还给输入框）。 */
  onPulledBack?: () => void;
}

function previewOf(message: QueuedMessage): string {
  const text = message.draft.text.trim().replace(/\s+/g, " ");
  if (text) return text;
  const skill = message.draft.skills[0]?.name;
  if (skill) return `使用 Skill：${skill}`;
  return (
    message.draft.textAttachments[0]?.name ?? message.draft.images[0]?.name ?? "（空消息）"
  );
}

function attachmentCount(message: QueuedMessage): number {
  return message.draft.images.length + message.draft.textAttachments.length;
}

/**
 * 输入区上方的发送队列：任务运行期间排好的消息，当前这一轮自然结束后依次自动发出。
 *
 * 队列的规则与暂停语义见 `agentQueueStore` 顶部注释；这里只负责把它**说清楚**——
 * 用户必须一眼看出「这些话还没发、什么时候发、为什么停了、怎么办」。
 */
export default function AgentQueueTray({ conversationId, mobile = false, onPulledBack }: Props) {
  const items = useAgentQueueStore((s) =>
    conversationId ? (s.items[conversationId] ?? EMPTY_QUEUE) : EMPTY_QUEUE,
  );
  const paused = useAgentQueueStore((s) =>
    conversationId ? s.paused[conversationId] : undefined,
  );
  if (!conversationId || items.length === 0) return null;

  const store = useAgentQueueStore.getState();
  // 触控目标 ≥44px；桌面指针精确，行可以紧凑。
  const iconButton = mobile
    ? "h-11 w-11 active:bg-state-mid/70"
    : "h-8 w-8 hover:bg-state-mid/60 active:bg-state-mid";

  return (
    <section
      aria-label="待发送队列"
      className="mb-2 min-w-0 overflow-hidden rounded-xl border border-edge/70 bg-surface-raised/50"
    >
      {paused ? (
        <div
          role="status"
          className="flex min-w-0 items-center gap-2 border-b border-amber-800/40 bg-amber-950/50 px-3 py-1.5 text-meta text-amber-200"
        >
          <span className="min-w-0 flex-1 leading-relaxed">{queuePauseText(paused)}</span>
          <button
            type="button"
            onClick={() => store.resume(conversationId)}
            className={`shrink-0 rounded-md px-2 font-medium text-amber-100 pressable hover:bg-amber-900/40 ${
              mobile ? "h-11" : "h-7"
            }`}
          >
            继续发送
          </button>
          <button
            type="button"
            onClick={() => store.clear(conversationId)}
            className={`shrink-0 rounded-md px-2 text-amber-300/80 pressable hover:bg-amber-900/40 ${
              mobile ? "h-11" : "h-7"
            }`}
          >
            清空
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 px-3 pt-1.5 text-caption text-fg-secondary">
          <span className="font-medium text-fg-secondary">待发送 {items.length} 条</span>
          <span className="min-w-0 truncate">当前任务完成后依次发出</span>
        </div>
      )}
      <ul className="min-w-0 divide-y divide-edge/40">
        {items.map((message, index) => {
          const extra = attachmentCount(message);
          return (
            <li
              key={message.id}
              className="card-reveal flex min-w-0 items-center gap-1 pl-3 pr-1"
            >
              <span
                aria-hidden="true"
                className="w-4 shrink-0 text-center text-caption tabular-nums text-fg-tertiary"
              >
                {index + 1}
              </span>
              <span
                className={`min-w-0 flex-1 truncate text-read text-fg ${
                  mobile ? "py-3" : "py-1.5"
                }`}
                title={message.draft.text || undefined}
              >
                {previewOf(message)}
              </span>
              {extra > 0 && (
                <span className="flex shrink-0 items-center gap-0.5 text-caption text-fg-secondary">
                  <Paperclip aria-hidden="true" className="h-3 w-3" />
                  {extra}
                </span>
              )}
              <button
                type="button"
                aria-label={`取回第 ${index + 1} 条到输入框编辑`}
                title="取回到输入框编辑"
                onClick={() => {
                  if (store.pullBack(conversationId, message.id)) onPulledBack?.();
                }}
                className={`flex shrink-0 items-center justify-center rounded-lg text-fg-secondary transition-transform duration-100 hover:text-fg ${iconButton}`}
              >
                <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-label={`移除第 ${index + 1} 条`}
                title="移除"
                onClick={() => store.remove(conversationId, message.id)}
                className={`flex shrink-0 items-center justify-center rounded-lg text-fg-secondary transition-transform duration-100 hover:text-red-300 ${iconButton}`}
              >
                <X aria-hidden="true" className="h-4 w-4" />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
