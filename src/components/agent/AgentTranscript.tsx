import { memo, useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { ArrowDown } from 'lucide-react';
import { useConversationStore } from '@/stores/conversationStore';
import { isNearBottom, shouldAutoScroll, shouldShowScrollToBottomFab } from '@/lib/agentScroll';
import type { AgentMessage } from '@/lib/types';
import AgentMessageList, { type AgentMessageListHandle } from './AgentMessageList';
import { MarkdownVisibility } from './markdownVisibility';
import { useAgentScrollIntent } from '@/hooks/useAgentScrollIntent';

const EMPTY_MESSAGES: AgentMessage[] = [];

interface Props {
  canInteract: boolean;
  conversationId: string | null;
  rollbackDisabled: boolean;
  userJustSentRef: MutableRefObject<boolean>;
  onRollback: (message: AgentMessage) => void;
  onCopy: (message: AgentMessage) => void;
  emptyState: ReactNode;
  mobile?: boolean;
  visible?: boolean;
}

/** The transcript alone subscribes to message frames; hidden mobile pages keep their last view. */
export default memo(function AgentTranscript({
  canInteract, conversationId, rollbackDisabled, userJustSentRef,
  onRollback, onCopy, emptyState, mobile = false, visible = true,
}: Props) {
  const snapshot = useRef(EMPTY_MESSAGES);
  const messages = useConversationStore((s) =>
    visible ? (conversationId ? s.messages[conversationId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES) : snapshot.current,
  );
  snapshot.current = messages;
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolling = useAgentScrollIntent(containerRef, visible);
  const contentRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<AgentMessageListHandle | null>(null);
  const nearBottomRef = useRef(true);
  const [nearBottom, setNearBottom] = useState(true);
  const previousConversation = useRef(conversationId);
  const lastMessage = messages[messages.length - 1];
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
    if (!canInteract || !lastMessage) return;
    if (!shouldAutoScroll(nearBottomRef.current, userJustSentRef.current)) return;
    scrollToBottom();
    userJustSentRef.current = false;
  }, [visible, conversationId, canInteract, lastMessage, scrollToBottom, userJustSentRef]);

  // Async Markdown, images, IME and composer growth all feed the same follow owner.
  useEffect(() => {
    if (!visible || typeof ResizeObserver === 'undefined') return;
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (nearBottomRef.current) scrollToBottom();
        else if (containerRef.current) {
          const node = containerRef.current;
          setNearBottom(isNearBottom(node.scrollTop, node.clientHeight, node.scrollHeight));
        }
      });
    });
    if (containerRef.current) observer.observe(containerRef.current);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [visible, scrollToBottom]);

  return (
    <div className="relative flex-1 min-h-0 min-w-0">
      <div
        ref={containerRef}
        className={`h-full min-h-0 overflow-y-auto overflow-x-hidden p-3 [container-type:inline-size] ${mobile ? 'overscroll-contain' : ''}`}
        onScroll={() => {
          const node = containerRef.current;
          if (!node || !visible) return;
          const near = isNearBottom(node.scrollTop, node.clientHeight, node.scrollHeight);
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
              alwaysShowActions={mobile}
              enableStickyFollow={false}
              onManualLayout={onManualLayout}
            />
            </MarkdownVisibility.Provider>
          )}
        </div>
      </div>
      {shouldShowScrollToBottomFab(nearBottom, messages.length > 0) && (
        <button
          type="button"
          onClick={() => scrollToBottom('smooth')}
          title="回到底部"
          aria-label="回到底部"
          className={mobile
            ? 'absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-zinc-600 bg-zinc-800/95 px-3 py-1.5 text-xs font-medium text-zinc-100 shadow-lg backdrop-blur-sm active:bg-zinc-700'
            : 'absolute bottom-3 right-3 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-zinc-600 bg-zinc-800/95 text-zinc-100 shadow-lg backdrop-blur-sm transition-colors hover:bg-zinc-700'}
        >
          {mobile ? '回到底部' : <ArrowDown className="h-4 w-4" />}
        </button>
      )}
    </div>
  );
});
