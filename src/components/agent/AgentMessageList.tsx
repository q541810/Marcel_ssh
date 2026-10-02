import {
  memo, useCallback, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState,
  type ReactNode, type RefObject,
} from 'react';
import { Virtualizer, type VirtualizerHandle } from 'virtua';
import type { AgentMessage } from '@/lib/types';
import { isNearBottom } from '@/lib/agentScroll';
import { isTurnStart } from '@/lib/agentTurnFold';
import { isTaskBusy } from '@/lib/agentStatus';
import { getErrorMessage } from '@/lib/errors';
import { useConversationStore } from '@/stores/conversationStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTaskStore } from '@/stores/taskStore';
import { useTurnFoldStore } from '@/stores/turnFoldStore';
import { useIsomorphicLayoutEffect } from '@/hooks/useStickyFollow';
import { useAgentScrollIntent } from '@/hooks/useAgentScrollIntent';
import AgentMessageItem from './AgentMessage';
import ToolCallCard from './ToolCallCard';
import { getToolView } from './toolViews';
import ExplorationGroup from './ExplorationGroup';
import { TurnFoldControl } from './TurnFoldGroup';
import { buildMessageRows, isRowPrepend, type MessageRow } from './agentMessageRows';
import { MarkdownVisibility } from './markdownVisibility';
import {
  MessageViewCacheContext, MessageViewIdContext, type MessageViewCache, useMessageViewState,
} from './messageViewState';

export interface AgentMessageListHandle {
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  followBottom: () => void;
}
interface Props {
  messages: AgentMessage[];
  rollbackDisabled?: boolean;
  onRollback?: (message: AgentMessage) => void;
  onCopy?: (message: AgentMessage) => void;
  messagesEndRef?: RefObject<HTMLDivElement>;
  highlightMessageId?: string | null;
  matchedMessageIds?: string[];
  searchKeyword?: string;
  alwaysShowActions?: boolean;
  conversationId?: string;
  foldTurns?: boolean;
  /** Standalone lists own following; live AgentTranscript explicitly opts out. */
  enableStickyFollow?: boolean;
  listRef?: RefObject<AgentMessageListHandle | null>;
}
const PAGE_SIZE = 50;
const TOP_MARGIN = 160;
const EMPTY_EXPANDED: Record<string, boolean> = {};

export function alignedWindowStart(messages: readonly AgentMessage[], count: number): number {
  const start = Math.max(0, messages.length - count);
  if (!start || isTurnStart(messages[start])) return start;
  let i = start - 1;
  while (i >= 0 && !isTurnStart(messages[i])) i--;
  return i >= 0 ? i : start;
}

function MessageBody({ message, grouped, ...props }: {
  message: AgentMessage; grouped?: boolean;
} & Pick<Props, 'onRollback' | 'onCopy' | 'rollbackDisabled' | 'alwaysShowActions' | 'searchKeyword'>) {
  const [expanded, setExpanded] = useMessageViewState('tool-width-expanded', false);
  const onExpand = useCallback((_id: string, open: boolean) => setExpanded(open), [setExpanded]);
  const ToolView = message.toolResult && getToolView(message.toolResult.toolName);
  if (ToolView) return <ToolView message={message} />;
  if (message.toolResult || (message.role === 'assistant' && message.toolCall)) {
    return <div className={`flex min-w-0 justify-start ${grouped ? 'pl-3' : ''}`}>
      <div className={`min-w-0 ${expanded ? 'w-full' : 'max-w-[85%]'}`}>
        <ToolCallCard message={message} onExpandChange={onExpand} />
      </div>
    </div>;
  }
  return <AgentMessageItem message={message} autoExpand={!!message.isThinking} {...props} />;
}
const MemoMessageBody = memo(MessageBody);

// Register only committed views, outside ref/layout updates that can recurse during measurement.
function DedicatedViewRetention({
  rowKey, onVisit,
}: {
  rowKey: string;
  onVisit: (rowKey: string) => void;
}) {
  useEffect(() => {
    onVisit(rowKey);
  }, [onVisit, rowKey]);
  return null;
}

function MessageList({
  messages, conversationId = '', rollbackDisabled = false, onRollback, onCopy, messagesEndRef,
  highlightMessageId = null, matchedMessageIds, searchKeyword, alwaysShowActions = false,
  foldTurns: foldTurnsProp, enableStickyFollow = true, listRef,
}: Props) {
  const visible = useContext(MarkdownVisibility);
  const [visibleCount, setVisibleCount] = useState(() => {
    const target = highlightMessageId ? messages.findIndex((m) => m.id === highlightMessageId) : -1;
    return target < 0 ? PAGE_SIZE : Math.max(PAGE_SIZE, messages.length - target);
  });
  const previousMessages = useRef(messages);
  useEffect(() => {
    if (!highlightMessageId) return;
    const index = messages.findIndex((m) => m.id === highlightMessageId);
    if (index >= 0) setVisibleCount((n) => Math.max(n, messages.length - index));
  }, [highlightMessageId, messages]);
  const start = alignedWindowStart(messages, Math.max(PAGE_SIZE, visibleCount));
  const previousStart = useRef(start);
  useEffect(() => {
    const added = messages.length - previousMessages.current.length;
    const shown = previousMessages.current.length - previousStart.current;
    previousMessages.current = messages;
    previousStart.current = start;
    if (added > 0) setVisibleCount((n) => Math.max(n, shown) + added);
  }, [messages, start]);
  const sliced = useMemo(() => start ? messages.slice(start) : messages, [messages, start]);
  const settingsFold = useSettingsStore((s) => s.settings.foldCompletedTurns ?? true);
  const expandedTurns = useTurnFoldStore((s) => s.expanded[conversationId] ?? EMPTY_EXPANDED);
  const tailActive = useTaskStore((s) => Object.values(s.tasks).some(
    (t) => t.conversationId === conversationId && !!t.sessionId && isTaskBusy(t.status),
  ));
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const matched = useMemo(() => new Set([
    ...(matchedMessageIds ?? []), ...(highlightMessageId ? [highlightMessageId] : []),
  ]), [matchedMessageIds, highlightMessageId]);
  const model = useMemo(() => buildMessageRows(sliced, {
    foldTurns: foldTurnsProp ?? settingsFold, tailActive, expandedTurns, expandedGroups, matchedIds: matched,
  }), [sliced, foldTurnsProp, settingsFold, tailActive, expandedTurns, expandedGroups, matched]);
  const { rows } = model;
  // Search expansions survive clearing the query, like the existing turn controls.
  useEffect(() => {
    model.forcedTurns.forEach((key) => useTurnFoldStore.getState().expandTurn(conversationId, key));
    if (model.forcedGroups.some((key) => !expandedGroups.has(key))) {
      setExpandedGroups((old) => new Set([...old, ...model.forcedGroups]));
    }
  }, [model, conversationId, expandedGroups]);

  const root = useRef<HTMLDivElement>(null);
  const listStart = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLElement | null>(null);
  const userScrolling = useAgentScrollIntent(scrollRef, visible);
  const virtualizer = useRef<VirtualizerHandle>(null);
  const virtual = typeof ResizeObserver !== 'undefined';
  const [margin, setMargin] = useState(0);
  const pinned = useRef(!highlightMessageId);
  const viewCache = useRef<MessageViewCache>(new Map());
  const [retained, setRetained] = useState<Set<string>>(() => new Set());
  const retainDedicatedView = useCallback((rowKey: string) => {
    setRetained((old) => old.has(rowKey) ? old : new Set([...old, rowKey]));
  }, []);
  const [held, setHeld] = useState<Set<string>>(() => new Set());
  const previousRows = useRef(rows);
  const shift = isRowPrepend(previousRows.current, rows);
  useIsomorphicLayoutEffect(() => { previousRows.current = rows; }, [rows]);
  const snapshot = useRef<{ top: number; height: number } | null>(null);
  const hasArchive = useConversationStore((s) =>
    // Read-only history owns its own data; never load an unrelated active conversation.
    s.messages[conversationId] === messages && (s.hasEarlierMessages[conversationId] ?? false),
  );
  const canLoad = start > 0 || hasArchive;
  const loading = useRef(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadErrorRef = useRef<string | null>(null);
  const loadEarlier = useCallback(async () => {
    if (!visible || !canLoad || loading.current || loadErrorRef.current) return;
    if (start > 0) {
      const node = scrollRef.current;
      if (!virtual && node) snapshot.current = { top: node.scrollTop, height: node.scrollHeight };
      setVisibleCount((n) => n + PAGE_SIZE);
      return;
    }
    loading.current = true;
    const before = useConversationStore.getState().messages[conversationId];
    try {
      await useConversationStore.getState().loadEarlierHistory(conversationId);
      const after = useConversationStore.getState();
      if (after.messages[conversationId] === before && after.hasEarlierMessages[conversationId]) {
        loadErrorRef.current = '历史消息暂未加载，请重试';
        setLoadError(loadErrorRef.current);
      }
    } catch (error) {
      loadErrorRef.current = getErrorMessage(error);
      setLoadError(loadErrorRef.current);
    } finally { loading.current = false; }
  }, [visible, canLoad, start, virtual, conversationId]);
  const latestLoad = useRef(loadEarlier);
  latestLoad.current = loadEarlier;

  const followBottom = useCallback(() => {
    // Continuous follow is a single write, not a persistent imperative scroll target.
    // Otherwise subsequent measurements can undo a user's wheel/touch scroll.
    pinned.current = true;
    userScrolling.current = false;
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [userScrolling]);
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    pinned.current = true;
    userScrolling.current = false;
    if (virtualizer.current && rows.length) {
      // Jump over large histories; don't mount every intermediate row for an animation.
      const nearby = virtualizer.current.scrollSize - virtualizer.current.scrollOffset
        < virtualizer.current.viewportSize * 2;
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      virtualizer.current.scrollToIndex(rows.length - 1, {
        align: 'end', smooth: behavior === 'smooth' && nearby && !reduceMotion,
      });
    } else if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [rows.length, userScrolling]);
  useImperativeHandle(listRef, () => ({ scrollToBottom, followBottom }), [scrollToBottom, followBottom]);

  useIsomorphicLayoutEffect(() => {
    const node = root.current?.closest<HTMLElement>('.overflow-y-auto') ?? root.current?.parentElement;
    if (!node) return;
    scrollRef.current = node;
    const oldAnchor = node.style.overflowAnchor;
    if (virtual) node.style.overflowAnchor = 'none';
    const measure = () => {
      if (listStart.current && node.clientHeight > 0) {
        setMargin(listStart.current.getBoundingClientRect().top
          - node.getBoundingClientRect().top + node.scrollTop - node.clientTop);
      }
    };
    measure();
    const observer = virtual ? new ResizeObserver(measure) : null;
    observer?.observe(node);
    const onScroll = () => {
      if (!visible) return;
      if (userScrolling.current) {
        pinned.current = isNearBottom(node.scrollTop, node.clientHeight, node.scrollHeight);
      }
      if (node.scrollTop <= TOP_MARGIN && !loadError) void latestLoad.current();
    };
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      node.style.overflowAnchor = oldAnchor;
      observer?.disconnect();
      node.removeEventListener('scroll', onScroll);
    };
  }, [virtual, visible, canLoad, loadError, userScrolling]);

  useIsomorphicLayoutEffect(() => {
    if (snapshot.current && scrollRef.current) {
      const node = scrollRef.current;
      node.scrollTop = snapshot.current.top + node.scrollHeight - snapshot.current.height;
      snapshot.current = null;
    }
  }, [rows]);
  const initialized = useRef(false);
  useIsomorphicLayoutEffect(() => {
    if (!visible || !rows.length || highlightMessageId) return;
    if (!initialized.current || (enableStickyFollow && pinned.current)) followBottom();
    initialized.current = true;
  }, [visible, rows, highlightMessageId, enableStickyFollow, followBottom]);
  useEffect(() => {
    if (!enableStickyFollow || !visible || !virtual || !root.current) return;
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (pinned.current && !highlightMessageId) followBottom();
      });
    });
    observer.observe(root.current);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [enableStickyFollow, visible, virtual, highlightMessageId, followBottom]);
  // Continue loading short/folded pages while the actual top remains in view.
  useEffect(() => {
    if (!visible || !canLoad || loadError) return;
    const node = scrollRef.current;
    if (!node) return;
    let frame = requestAnimationFrame(() => {
      frame = 0;
      const header = root.current?.firstElementChild;
      if (header && header.getBoundingClientRect().bottom >= node.getBoundingClientRect().top - TOP_MARGIN
        && (!virtual || node.scrollTop <= TOP_MARGIN)) void latestLoad.current();
    });
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) void latestLoad.current(); },
      { root: node, rootMargin: `${TOP_MARGIN}px 0px 0px 0px` },
    );
    if (root.current?.firstElementChild) observer?.observe(root.current.firstElementChild);
    return () => { if (frame) cancelAnimationFrame(frame); observer?.disconnect(); };
  }, [rows, visible, canLoad, virtual, loadError]);

  // A focused control/selection and already-mounted dedicated views must not be destroyed by scrolling.
  useEffect(() => {
    const updateHeld = () => {
      const next = new Set<string>();
      const add = (node: Node | null) => {
        const element = node instanceof Element ? node : node?.parentElement;
        const row = element?.closest<HTMLElement>('[data-virtual-row-key]');
        if (row && root.current?.contains(row)) next.add(row.dataset.virtualRowKey!);
      };
      add(document.activeElement);
      const selection = document.getSelection();
      if (selection && !selection.isCollapsed) {
        root.current?.querySelectorAll<HTMLElement>('[data-virtual-row-key]').forEach((row) => {
          if (selection.containsNode(row, true)) next.add(row.dataset.virtualRowKey!);
        });
      }
      setHeld((old) => old.size === next.size && [...next].every((id) => old.has(id)) ? old : next);
    };
    document.addEventListener('selectionchange', updateHeld);
    document.addEventListener('focusin', updateHeld);
    return () => {
      document.removeEventListener('selectionchange', updateHeld);
      document.removeEventListener('focusin', updateHeld);
    };
  }, []);
  useEffect(() => {
    // A temporarily unloaded snapshot is not evidence of a rollback/deletion.
    if (!messages.length) return;
    const ids = new Set(messages.map((m) => m.id));
    for (const id of viewCache.current.keys()) if (!ids.has(id)) viewCache.current.delete(id);
    const keys = new Set(rows.map((r) => r.key));
    setRetained((old) => [...old].every((key) => keys.has(key)) ? old
      : new Set([...old].filter((key) => keys.has(key))));
  }, [messages, rows]);
  const keepMounted = rows.flatMap((row, index) => {
    const active = row.kind === 'message' && (
      row.message.isExecuting || row.message.isThinking || row.message.isLoading || row.message.isRetrying
      || row.message.compaction?.status === 'running'
    );
    return held.has(row.key) || retained.has(row.key) || active ? [index] : [];
  });
  const lastHighlight = useRef<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!highlightMessageId) { lastHighlight.current = null; return; }
    if (lastHighlight.current === highlightMessageId) return;
    const index = rows.findIndex((row) => row.kind === 'message' && row.message.id === highlightMessageId);
    if (index < 0) return;
    lastHighlight.current = highlightMessageId;
    pinned.current = false;
    if (virtualizer.current) virtualizer.current.scrollToIndex(index, { align: 'center' });
    else root.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(highlightMessageId)}"]`)
      ?.scrollIntoView?.({ block: 'center' });
    setFlash(highlightMessageId);
  }, [highlightMessageId, rows]);
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 2000);
    return () => clearTimeout(timer);
  }, [flash]);

  const renderRow = (row: MessageRow): ReactNode => {
    if (row.kind === 'turn') return <TurnFoldControl segment={row.segment} open={row.open}
      onToggle={() => useTurnFoldStore.getState().toggleTurn(conversationId, row.segment.key)} />;
    if (row.kind === 'group') return <ExplorationGroup kind={row.group} messages={row.messages}
      headerOnly expanded={row.open} onToggle={() => setExpandedGroups((old) => {
        const next = new Set(old);
        if (next.has(row.key)) next.delete(row.key); else next.add(row.key);
        return next;
      })} />;
    const message = row.message;
    return <MessageViewIdContext.Provider value={message.id}>
      <div data-message-id={message.id}
        className={`relative min-w-0 rounded-lg ${matched.has(message.id) ? 'border-l-2 border-indigo-400 pl-2' : ''}
          ${flash === message.id ? 'bg-indigo-500/20 ring-1 ring-indigo-400/30' : ''}`}>
        <MemoMessageBody message={message} grouped={row.grouped} rollbackDisabled={rollbackDisabled}
          onRollback={onRollback} onCopy={onCopy} searchKeyword={searchKeyword} alwaysShowActions={alwaysShowActions} />
      </div>
    </MessageViewIdContext.Provider>;
  };
  const rowElement = (row: MessageRow) => {
    const dedicated = row.kind === 'message'
      && !!row.message.toolResult
      && !!getToolView(row.message.toolResult.toolName);
    return <div key={row.key} data-virtual-row-key={row.key}
      className="min-w-0 w-full pb-1 flow-root">
      {dedicated && <DedicatedViewRetention rowKey={row.key} onVisit={retainDedicatedView} />}
      {renderRow(row)}
    </div>;
  };

  return <MessageViewCacheContext.Provider value={viewCache.current}>
    <div ref={root} className="min-w-0 w-full" data-agent-message-list data-virtualized={virtual}>
      {canLoad && <div className="flex items-center justify-center py-2 text-xs text-zinc-500">
        {loadError ? <button type="button" onClick={() => {
          loadErrorRef.current = null;
          setLoadError(null);
          void loadEarlier();
        }}>
          {loadError} · 重试
        </button> : '加载更早消息...'}
      </div>}
      <div ref={listStart}>
        {virtual ? <Virtualizer ref={virtualizer} scrollRef={scrollRef} startMargin={margin}
          data={rows} shift={shift} bufferSize={600} ssrCount={12} keepMounted={keepMounted}>
          {rowElement}
        </Virtualizer> : rows.map(rowElement)}
      </div>
      {messagesEndRef && <div ref={messagesEndRef} />}
    </div>
  </MessageViewCacheContext.Provider>;
}

export default memo(function AgentMessageList(props: Props) {
  const activeId = useConversationStore((s) => s.activeConversationId);
  const id = props.conversationId ?? activeId ?? '';
  return <MessageList key={id || 'unbound'} {...props} conversationId={id} />;
});
