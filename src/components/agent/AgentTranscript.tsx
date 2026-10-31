import { memo, useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { ArrowDown } from 'lucide-react';
import { useConversationStore } from '@/stores/conversationStore';
import { isNearBottom, shouldAutoScroll, shouldShowScrollToBottomFab } from '@/lib/agentScroll';
import { MOBILE_MAX_RETAINED_VIEWS } from '@/lib/retainedViews';
import type { AgentMessage } from '@/lib/types';
import AgentMessageList, { type AgentMessageListHandle } from './AgentMessageList';
import AgentRunStatus, { useConversationLoopRunning } from './AgentRunStatus';
import { MarkdownVisibility } from './markdownVisibility';
import { useAgentScrollIntent } from '@/hooks/useAgentScrollIntent';
import { useAnimatedPresence } from '@/hooks/useAnimatedPresence';

const EMPTY_MESSAGES: AgentMessage[] = [];

interface Props {
  canInteract: boolean;
  conversationId: string | null;
  rollbackDisabled: boolean;
  userJustSentRef: MutableRefObject<boolean>;
  onRollback: (message: AgentMessage) => void;
  onCopy: (message: AgentMessage) => void;
  /** 任务收尾条的「复制」写剪贴板用；失败请抛出。不传 = 不显示收尾条。 */
  onCopyText?: (text: string) => void | Promise<void>;
  /** 任务收尾条的「分叉」：从该任务收尾处分叉出新会话。不传 = 不显示分叉按钮。 */
  onFork?: (messageId: string) => void | Promise<void>;
  emptyState: ReactNode;
  mobile?: boolean;
  visible?: boolean;
}

/** The transcript alone subscribes to message frames; hidden mobile pages keep their last view. */
export default memo(function AgentTranscript({
  canInteract, conversationId, rollbackDisabled, userJustSentRef,
  onRollback, onCopy, onCopyText, onFork, emptyState, mobile = false, visible = true,
}: Props) {
  const snapshot = useRef(EMPTY_MESSAGES);
  const messages = useConversationStore((s) =>
    visible ? (conversationId ? s.messages[conversationId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES) : snapshot.current,
  );
  snapshot.current = messages;
  const loopRunning = useConversationLoopRunning(conversationId);
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolling = useAgentScrollIntent(containerRef, visible);
  const contentRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<AgentMessageListHandle | null>(null);
  const nearBottomRef = useRef(true);
  const lastScroll = useRef({ top: 0, height: 0 });
  const [nearBottom, setNearBottom] = useState(true);
  const previousConversation = useRef(conversationId);
  // 只认「消息换了」这一个信号。若依赖整个 lastMessage 对象，流式每个 delta 都会重跑一次
  // 贴底，和 ResizeObserver 抢同一个 scrollTop；内容增长交给 ResizeObserver 独占。
  const lastMessageId = messages.length ? messages[messages.length - 1].id : null;
  const onManualLayout = useCallback(() => {
    // A disclosure is a reading action. Its header owns the viewport until the next scroll.
    nearBottomRef.current = false;
    userScrolling.current = false;
    setNearBottom(false);
  }, [userScrolling]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const container = containerRef.current;
    if (!container) return;
    userScrolling.current = false;
    if (listRef.current) {
      if (behavior === 'auto') listRef.current.followBottom();
      else listRef.current.scrollToBottom(behavior);
    }
    else if (behavior === 'smooth') container.scrollTo({ top: container.scrollHeight, behavior });
    else container.scrollTop = container.scrollHeight;
    nearBottomRef.current = true;
    setNearBottom(true);
  }, [userScrolling]);

  useEffect(() => {
    if (!visible) return;
    if (previousConversation.current !== conversationId) {
      previousConversation.current = conversationId;
      nearBottomRef.current = true;
    }
    if (!canInteract || !lastMessageId) return;
    if (!shouldAutoScroll(nearBottomRef.current, userJustSentRef.current)) return;
    scrollToBottom();
    userJustSentRef.current = false;
  }, [visible, conversationId, canInteract, lastMessageId, scrollToBottom, userJustSentRef]);

  // Async Markdown, images, IME and composer growth all feed the same follow owner.
  useEffect(() => {
    if (!visible || typeof ResizeObserver === 'undefined') return;
    // 回调内同步贴底：ResizeObserver 在布局之后、绘制之前触发，此刻写 scrollTop 用户看不到
    // 中间帧；若再套一层 rAF，每次内容变高/变矮（折叠动画、流式、拖宽）都会先画出一帧
    // 偏离底部的画面，下一帧再拉回，表现为上下抖动。
    const observer = new ResizeObserver(() => {
      if (userScrolling.current && !nearBottomRef.current) return;
      if (nearBottomRef.current) scrollToBottom();
      else if (containerRef.current) {
        const node = containerRef.current;
        setNearBottom(isNearBottom(node.scrollTop, node.clientHeight, node.scrollHeight));
      }
    });
    if (containerRef.current) observer.observe(containerRef.current);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [visible, scrollToBottom, userScrolling]);

  const scrollFab = useAnimatedPresence(shouldShowScrollToBottomFab(nearBottom, messages.length > 0));

  return (
    <div className="relative flex-1 min-h-0 min-w-0">
      <div
        ref={containerRef}
        className={`h-full min-h-0 overflow-y-auto overflow-x-hidden p-3 [container-type:inline-size] ${mobile ? 'overscroll-contain' : ''}`}
        onScroll={() => {
          const node = containerRef.current;
          if (!node || !visible) return;
          let near = isNearBottom(node.scrollTop, node.clientHeight, node.scrollHeight);
          // 用户亲手上滑（内容没缩短）时立刻脱离贴底：否则离底 80px 内的小幅上滑
          // 仍算"在底部"，流式增高会把视口拽回去，表现为反复抽搐，必须拉出阈值才停。
          const movedUp = node.scrollTop < lastScroll.current.top
            && node.scrollHeight >= lastScroll.current.height;
          lastScroll.current = { top: node.scrollTop, height: node.scrollHeight };
          if (userScrolling.current && movedUp) near = false;
          if (userScrolling.current) nearBottomRef.current = near;
          setNearBottom(near);
        }}
      >
        <div ref={contentRef} className={`${mobile ? '' : 'space-y-1'} agent-content-column`}>
          {(!canInteract || messages.length === 0) && emptyState}
          {canInteract && (
            <MarkdownVisibility.Provider value={visible}>
            <AgentMessageList
              listRef={listRef}
              messages={messages}
              conversationId={conversationId ?? undefined}
              rollbackDisabled={rollbackDisabled}
              onRollback={onRollback}
              onCopy={onCopy}
              onCopyText={onCopyText}
              onFork={onFork}
              alwaysShowActions={mobile}
              maxRetainedViews={mobile ? MOBILE_MAX_RETAINED_VIEWS : undefined}
              enableStickyFollow={false}
              onManualLayout={onManualLayout}
            />
            </MarkdownVisibility.Provider>
          )}
          {canInteract && loopRunning && conversationId && <AgentRunStatus conversationId={conversationId} />}
        </div>
      </div>
      {scrollFab.mounted && (mobile ? (
        <button
          type="button"
          onClick={() => scrollToBottom('smooth')}
          title="回到底部"
          aria-label="回到底部"
          onAnimationEnd={scrollFab.onAnimationEnd}
          className={`absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-edge-strong bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-100 shadow-lg active:bg-state-mid ${scrollFab.phase === 'exit' ? 'scroll-fab-exit' : 'scroll-fab-enter'}`}
        >
          回到底部
        </button>
      ) : (
        // 桌面端贴内容列右缘而不是面板右缘：限宽布局下面板右缘在两侧留白里，会压在宽度把手上。
        // 整层 pointer-events-none，只有按钮接事件，不挡下面的消息。
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 px-3">
          <div className="agent-content-column flex justify-end">
            <button
              type="button"
              onClick={() => scrollToBottom('smooth')}
              title="回到底部"
              aria-label="回到底部"
              onAnimationEnd={scrollFab.onAnimationEnd}
              className={`pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-edge-strong bg-zinc-800 text-zinc-100 shadow-lg hover:bg-state-mid ${scrollFab.phase === 'exit' ? 'scroll-fab-exit' : 'scroll-fab-enter'}`}
            >
              <ArrowDown className="h-4 w-4" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
});
