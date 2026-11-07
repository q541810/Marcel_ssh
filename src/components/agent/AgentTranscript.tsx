import { memo, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { ArrowDown } from 'lucide-react';
import { useConversationStore } from '@/stores/conversationStore';
import { isNearBottom, shouldAutoScroll, shouldShowScrollToBottomFab } from '@/lib/agentScroll';
import { MOBILE_MAX_RETAINED_VIEWS } from '@/lib/retainedViews';
import type { AgentMessage } from '@/lib/types';
import AgentMessageList, { type AgentMessageListHandle } from './AgentMessageList';
import AgentRunStatus, { useConversationLoopRunning } from './AgentRunStatus';
import { MarkdownVisibility } from './markdownVisibility';
import { useAgentScrollIntent } from '@/hooks/useAgentScrollIntent';
import { JUMP_TTL_MS, useMessageJumpStore } from '@/stores/messageJumpStore';
import { resolveJumpRequest } from '@/lib/jumpResolve';
import SubagentAwaitingNotice from './SubagentAwaitingNotice';
import { MessageJumpContext, type MessageJumpScope } from './messageJumpContext';
import { useSettingsStore } from '@/stores/settingsStore';
import { MascotPerch, PERCH_RESERVE_PX } from '@/components/mascot/MascotPerch';

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
  const lastMessage = messages[messages.length - 1];
  const showMascot = useSettingsStore((s) => s.settings.showMascot ?? true);
  // 有消息时玛瑟尔坐在消息区右下角；空白页（没消息 / 用不了助手）由 emptyState 里的大图负责
  const perched = showMascot && canInteract && !!conversationId && messages.length > 0;

  // 跳转请求的执行方：请求属于本对话、本面板可见时，解析目标消息并交给列表句柄。
  // 对话还没切过来 / 消息还没载入时请求留在 store 里，messages 变化时重试；过期丢弃。
  const jumpRequest = useMessageJumpStore((s) => s.request);
  useEffect(() => {
    if (!jumpRequest || !visible || !canInteract) return;
    if (jumpRequest.conversationId !== conversationId) return;
    const settle = () => useMessageJumpStore.getState().settle(jumpRequest.seq);
    if (Date.now() - jumpRequest.requestedAt > JUMP_TTL_MS) { settle(); return; }
    const target = resolveJumpRequest(messages, jumpRequest);
    if (!target) {
      // 消息可能还在载入：到期前不放弃
      const timer = setTimeout(settle, Math.max(0, JUMP_TTL_MS - (Date.now() - jumpRequest.requestedAt)));
      return () => clearTimeout(timer);
    }
    if (listRef.current?.jumpToMessage(target.id)) settle();
  }, [jumpRequest, visible, canInteract, conversationId, messages]);

  const jumpScope = useMemo<MessageJumpScope | null>(
    () => (conversationId ? { conversationId } : null),
    [conversationId],
  );
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
    // 回调内同步贴底：ResizeObserver 在布局之后、绘制之前触发，此刻写 scrollTop 用户看不到
    // 中间帧；若再套一层 rAF，每次内容变高/变矮（折叠动画、流式、拖宽）都会先画出一帧
    // 偏离底部的画面，下一帧再拉回，表现为上下抖动。
    const observer = new ResizeObserver(() => {
      if (nearBottomRef.current) scrollToBottom();
      else if (containerRef.current) {
        const node = containerRef.current;
        setNearBottom(isNearBottom(node.scrollTop, node.clientHeight, node.scrollHeight));
      }
    });
    if (containerRef.current) observer.observe(containerRef.current);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [visible, scrollToBottom]);

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
            <MessageJumpContext.Provider value={jumpScope}>
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
            </MessageJumpContext.Provider>
            </MarkdownVisibility.Provider>
          )}
          {canInteract && loopRunning && conversationId && <AgentRunStatus conversationId={conversationId} />}
          {canInteract && conversationId && (
            <SubagentAwaitingNotice conversationId={conversationId} messages={messages} mobile={mobile} />
          )}
          {perched && <div aria-hidden="true" style={{ height: PERCH_RESERVE_PX }} />}
        </div>
      </div>
      {mobile && perched && conversationId && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-3">
          <div className="agent-content-column flex justify-end">
            <MascotPerch conversationId={conversationId} />
          </div>
        </div>
      )}
      {mobile && shouldShowScrollToBottomFab(nearBottom, messages.length > 0) && (
        <button
          type="button"
          onClick={() => scrollToBottom('smooth')}
          title="回到底部"
          aria-label="回到底部"
          className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-edge-strong bg-surface-raised/95 px-3 py-1.5 text-meta font-medium text-fg shadow-raised backdrop-blur-sm active:bg-state-mid"
        >
          回到底部
        </button>
      )}
      {!mobile && (perched || shouldShowScrollToBottomFab(nearBottom, messages.length > 0)) && (
        // 桌面端贴内容列右缘而不是面板右缘：限宽布局下面板右缘在两侧留白里，会压在宽度把手上。
        // 整层 pointer-events-none，只有按钮和玛瑟尔的身子接事件，不挡下面的消息。
        // 玛瑟尔坐在消息区下沿（= 计划条 / 输入框上沿），「回到底部」排在它左边，两者不重叠。
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-3">
          <div className="agent-content-column flex items-end justify-end gap-2">
            {shouldShowScrollToBottomFab(nearBottom, messages.length > 0) && (
              <button
                type="button"
                onClick={() => scrollToBottom('smooth')}
                title="回到底部"
                aria-label="回到底部"
                className="pointer-events-auto mb-3 flex h-8 w-8 items-center justify-center rounded-full border border-edge-strong bg-surface-raised/95 text-fg shadow-raised backdrop-blur-sm transition-colors hover:bg-state-mid"
              >
                <ArrowDown className="h-4 w-4" />
              </button>
            )}
            {perched && conversationId && <MascotPerch conversationId={conversationId} />}
          </div>
        </div>
      )}
    </div>
  );
});
