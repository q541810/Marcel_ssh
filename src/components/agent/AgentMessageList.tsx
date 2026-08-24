import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { AgentMessage } from "@/lib/types";
import AgentMessageItem from "./AgentMessage";
import ToolCallCard from "./ToolCallCard";
import { getToolView } from "./toolViews";
import ExplorationGroup, {
  isExplorationTool,
  isPlanToolMessage,
  type ToolGroupKind,
} from "./ExplorationGroup";

interface Props {
  messages: AgentMessage[];
  isThinking: boolean;
  isRunning?: boolean;
  onRollback?: (message: AgentMessage) => void;
  onCopy?: (message: AgentMessage) => void;
  messagesEndRef?: RefObject<HTMLDivElement>;
  /** 当前定位的匹配消息 id：滚动 + 黄底渐隐 */
  highlightMessageId?: string | null;
  /** 所有匹配消息 id：左侧标记 */
  matchedMessageIds?: string[];
  /** 搜索关键词（用于正文高亮，可选） */
  searchKeyword?: string;
  /** 触屏端无 hover：消息操作行常显（透传 AgentMessage） */
  alwaysShowActions?: boolean;
}

type RenderItem = AgentMessage | { kind: ToolGroupKind; tools: AgentMessage[] };

/** 探索类工具连续出现至少 4 条才折叠（高频、占空间大）。 */
const EXPLORATION_MIN_COUNT = 4;
/** plan 工具连续出现至少 2 条就折叠（单行文本，两条即值得收拢）。 */
const PLAN_MIN_COUNT = 2;

/** 初始渲染及每批向上加载的消息条数 */
const PAGE_SIZE = 50;

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

function buildRenderItems(messages: AgentMessage[]) {
  const result: RenderItem[] = [];
  const visibleMessages = messages.filter((msg) => {
    if (msg.role !== "assistant") return true;
    return msg.isLoading || msg.content || msg.reasoningContent || msg.toolCall;
  });
  const n = visibleMessages.length;
  let i = 0;
  while (i < n) {
    const msg = visibleMessages[i];
    const kind = isExplorationTool(msg)
      ? ("exploration" as const)
      : isPlanToolMessage(msg)
        ? ("plan" as const)
        : null;
    if (kind) {
      const isSameKind =
        kind === "exploration" ? isExplorationTool : isPlanToolMessage;
      const minCount =
        kind === "exploration" ? EXPLORATION_MIN_COUNT : PLAN_MIN_COUNT;
      let j = i;
      while (j < n && isSameKind(visibleMessages[j])) j++;
      if (j - i >= minCount) {
        result.push({
          kind,
          tools: visibleMessages.slice(i, j),
        });
        i = j;
        continue;
      }
    }
    result.push(msg);
    i++;
  }
  return result;
}

export default function AgentMessageList({
  messages,
  isThinking,
  isRunning = false,
  onRollback,
  onCopy,
  messagesEndRef,
  highlightMessageId = null,
  matchedMessageIds,
  searchKeyword,
  alwaysShowActions = false,
}: Props) {
  // 分页展示条数，默认展示最近 PAGE_SIZE 条
  const [visibleCount, setVisibleCount] = useState(() =>
    Math.min(messages.length, PAGE_SIZE),
  );

  // 会话切换探测标识
  const conversationKey = `${messages[0]?.id ?? ""}-${messages[messages.length - 1]?.id ?? ""}`;
  const lastConversationKeyRef = useRef(conversationKey);
  const prevMessagesLengthRef = useRef(messages.length);

  // 滚动容器与锚定位置记忆
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const scrollSnapshotRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);

  // 会话切换时重置分页窗口；同一个会话新增消息时，窗口顺延扩展保证最新消息能可见
  useEffect(() => {
    if (lastConversationKeyRef.current !== conversationKey) {
      lastConversationKeyRef.current = conversationKey;
      prevMessagesLengthRef.current = messages.length;
      setVisibleCount(Math.min(messages.length, PAGE_SIZE));
      return;
    }

    const prevLen = prevMessagesLengthRef.current;
    if (messages.length > prevLen) {
      const diff = messages.length - prevLen;
      prevMessagesLengthRef.current = messages.length;
      setVisibleCount((prev) => Math.min(messages.length, prev + diff));
    } else {
      prevMessagesLengthRef.current = messages.length;
    }
  }, [conversationKey, messages.length]);

  // 搜索或高亮定位的消息如果在未加载的更早历史中，自动展开到包含该消息
  useEffect(() => {
    if (!highlightMessageId) return;
    const targetIdx = messages.findIndex((m) => m.id === highlightMessageId);
    if (targetIdx !== -1) {
      const neededCount = messages.length - targetIdx + 10; // 额外增加缓冲区
      setVisibleCount((prev) => (neededCount > prev ? Math.min(messages.length, neededCount) : prev));
    }
  }, [highlightMessageId, messages]);

  // 截取尾部可见消息
  const effectiveVisibleCount = Math.min(messages.length, Math.max(PAGE_SIZE, visibleCount));
  const hasMore = messages.length > effectiveVisibleCount;
  const slicedMessages = useMemo(() => {
    if (!hasMore) return messages;
    return messages.slice(messages.length - effectiveVisibleCount);
  }, [messages, effectiveVisibleCount, hasMore]);

  const renderItems = useMemo(() => buildRenderItems(slicedMessages), [slicedMessages]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const matchedSet = useMemo(
    () => new Set(matchedMessageIds ?? []),
    [matchedMessageIds],
  );
  const [flashId, setFlashId] = useState<string | null>(null);

  // 加载上一页消息并执行滚动位置锚定
  const loadMoreEarlierMessages = useCallback(() => {
    if (!hasMore) return;
    const sentinel = topSentinelRef.current;
    const container =
      scrollContainerRef.current ??
      (sentinel?.closest(".overflow-y-auto") as HTMLElement | null) ??
      sentinel?.parentElement;

    if (container) {
      scrollContainerRef.current = container;
      scrollSnapshotRef.current = {
        scrollHeight: container.scrollHeight,
        scrollTop: container.scrollTop,
      };
    }

    setVisibleCount((prev) => Math.min(messages.length, prev + PAGE_SIZE));
  }, [hasMore, messages.length]);

  // 在 DOM 增加较早消息后同步补齐滚动高度，保持视口绝对内容平滑不动
  useIsomorphicLayoutEffect(() => {
    const snapshot = scrollSnapshotRef.current;
    const container = scrollContainerRef.current;
    if (!snapshot || !container) return;

    const delta = container.scrollHeight - snapshot.scrollHeight;
    if (delta > 0) {
      container.scrollTop = snapshot.scrollTop + delta;
    }
    scrollSnapshotRef.current = null;
  }, [slicedMessages]);

  // 监听顶部哨兵元素进行触顶自动加载
  useEffect(() => {
    if (!hasMore) return;
    const sentinel = topSentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const first = entries[0];
        if (first?.isIntersecting) {
          loadMoreEarlierMessages();
        }
      },
      {
        root: sentinel.closest(".overflow-y-auto") as HTMLElement | null,
        rootMargin: "160px 0px 0px 0px", // 提前 160px 预加载，保证无缝滚动
        threshold: 0.01,
      },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadMoreEarlierMessages]);

  const handleToolExpandChange = useCallback(
    (messageId: string, expanded: boolean) => {
      setExpandedIds((prev) => {
        const has = prev.has(messageId);
        if (expanded === has) return prev;
        const next = new Set(prev);
        if (expanded) next.add(messageId);
        else next.delete(messageId);
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    if (!highlightMessageId) return;
    let cancelled = false;
    setFlashId(highlightMessageId);

    const tryScroll = () => {
      const el = document.querySelector(
        `[data-message-id="${CSS.escape(highlightMessageId)}"]`,
      ) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        return true;
      }
      return false;
    };

    // ExplorationGroup 可能需先 forceExpand 再挂 data-message-id
    if (!tryScroll()) {
      requestAnimationFrame(() => {
        if (cancelled) return;
        if (!tryScroll()) {
          window.setTimeout(() => {
            if (!cancelled) tryScroll();
          }, 50);
        }
      });
    }

    const t = window.setTimeout(() => setFlashId(null), 2000);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [highlightMessageId]);

  const wrapMessage = (msg: AgentMessage, node: ReactNode) => {
    const isMatch = matchedSet.has(msg.id);
    const isFlash = flashId === msg.id;
    return (
      <div
        key={msg.id}
        data-message-id={msg.id}
        className={`relative min-w-0 rounded-lg transition-colors duration-500 ${
          isFlash ? "bg-indigo-500/20 ring-1 ring-indigo-400/30" : ""
        } ${isMatch ? "pl-2" : ""}`}
      >
        {isMatch && (
          <span
            className="absolute left-0 top-2 bottom-2 w-1 rounded-full bg-indigo-400/70"
            aria-hidden
          />
        )}
        {node}
      </div>
    );
  };

  return (
    <>
      {hasMore && (
        <div
          ref={topSentinelRef}
          className="flex items-center justify-center py-2 text-xs text-zinc-500"
        >
          <div className="flex items-center gap-1.5 opacity-60">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-zinc-400 animate-pulse" />
            <span>加载更早消息...</span>
          </div>
        </div>
      )}
      {renderItems.map((item) =>
        "kind" in item ? (
          <ExplorationGroup
            key={`${item.kind}-${item.tools[0].id}`}
            kind={item.kind}
            messages={item.tools}
            autoExpand={isThinking}
            forceExpand={item.tools.some(
              (t) => matchedSet.has(t.id) || t.id === highlightMessageId,
            )}
            matchedIds={matchedSet}
            flashId={flashId}
          />
        ) : (
          (() => {
            const msg = item as AgentMessage;
            if (msg.role === "tool" && msg.toolResult) {
              const ToolView = getToolView(msg.toolResult.toolName);
              if (ToolView) {
                return wrapMessage(
                  msg,
                  <div className="min-w-0 w-full">
                    <ToolView message={msg} />
                  </div>,
                );
              }
            }
            if (
              (msg.role === "tool" && msg.toolResult) ||
              (msg.role === "assistant" && msg.toolCall)
            ) {
              return wrapMessage(
                msg,
                <div className="flex min-w-0 justify-start">
                  <div
                    className={`min-w-0 ${expandedIds.has(msg.id) ? "w-full" : "max-w-[85%]"}`}
                  >
                    <ToolCallCard
                      message={msg}
                      autoExpand={isThinking}
                      messageId={msg.id}
                      onExpandChange={handleToolExpandChange}
                    />
                  </div>
                </div>,
              );
            }
            return wrapMessage(
              msg,
              <AgentMessageItem
                message={msg}
                autoExpand={!!msg.isThinking}
                rollbackDisabled={isRunning}
                onRollback={onRollback}
                onCopy={onCopy}
                searchKeyword={searchKeyword}
                alwaysShowActions={alwaysShowActions}
              />,
            );
          })()
        ),
      )}
      {messagesEndRef && <div ref={messagesEndRef} />}
    </>
  );
}
