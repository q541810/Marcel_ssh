import {
  memo,
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
import { isNearBottom } from "@/lib/agentScroll";
import { useConversationStore } from "@/stores/conversationStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTaskStore } from "@/stores/taskStore";
import { segmentTurns, type TurnSegment } from "@/lib/agentTurnFold";
import AgentMessageItem from "./AgentMessage";
import ToolCallCard from "./ToolCallCard";
import { getToolView } from "./toolViews";
import ExplorationGroup, {
  isExplorationTool,
  isPlanToolMessage,
  type ToolGroupKind,
} from "./ExplorationGroup";
import { TurnFoldGroup } from "./TurnFoldGroup";

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
  /** 本列表所属对话 id（缺省用全局 activeConversationId；历史浏览等
   *  非活跃列表必须显式传，否则运行态判定会查错对话）。 */
  conversationId?: string;
  /** 是否启用回合折叠。false = 本列表永不折叠（历史只读/检索视图）。
   *  缺省跟随全局设置 foldCompletedTurns。 */
  foldTurns?: boolean;
}

type RenderItem =
  | AgentMessage
  | { kind: ToolGroupKind; tools: AgentMessage[] }
  | { kind: "turn-fold"; segment: TurnSegment };

/** 探索类工具连续出现至少 4 条才折叠（高频、占空间大）。 */
const EXPLORATION_MIN_COUNT = 4;
/** plan 工具连续出现至少 2 条就折叠（单行文本，两条即值得收拢）。 */
const PLAN_MIN_COUNT = 2;

/** 初始渲染及每批向上加载的消息条数 */
const PAGE_SIZE = 50;

/** 顶部哨兵检测带高度。必须与哨兵 IntersectionObserver 的 rootMargin
 *  顶部一致：一批新消息若全被回合折叠成矮行，哨兵不会离开该带，
 *  IO 也就不会再产生 crossing 回调——由布局后复查自动续载兜底。 */
const TOP_SENTINEL_MARGIN = 160;

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * 计算分页窗口起点：从尾部取 count 条，若起点切在某个回合中间（非 user），
 * 向前多取到该回合的 user，保证窗口内起始回合完整 —— 折叠判定跨翻页稳定，
 * 避免“半截展开 → 补全后折叠”的突变。找不到 user（消息流本身以非 user
 * 开头）则返回原始起点，由 segmentTurns 的 lone 分支兜底（不折叠）。
 */
export function alignedWindowStart(
  messages: readonly AgentMessage[],
  count: number,
): number {
  const n = messages.length;
  if (n === 0) return 0;
  let start = Math.max(0, n - count);
  if (start === 0 || messages[start]?.role === "user") return start;
  let p = start - 1;
  while (p >= 0 && messages[p]?.role !== "user") p -= 1;
  return p >= 0 ? p : start;
}

/** 对一段连续消息做「探索/plan 组折叠」的普通渲染 items（不含 turn 折叠）。
 *  段边界在 user，探索组天然不会跨段，可独立对每段调用。 */
function buildGroupedItems(messages: AgentMessage[]): RenderItem[] {
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

/** 把（已分页的）消息流切成「回合段」：可折叠长回合 → turn-fold item；
 *  其余按段做探索/plan 组折叠后展开为普通 items。
 *  @param tailActive 尾回合（最后 user 之后的回合）任务是否在跑 —— 在跑则
 *   永不折叠（对齐 DSH「任务完成后才收起」，避免中途插话被误判成回合结束）。 */
function buildTurnItems(
  messages: AgentMessage[],
  tailActive: boolean,
): RenderItem[] {
  const segs = segmentTurns(messages, { tailActive });
  const result: RenderItem[] = [];
  for (const seg of segs) {
    if (seg.foldable) {
      result.push({ kind: "turn-fold", segment: seg });
    } else {
      result.push(...buildGroupedItems(seg.messages as AgentMessage[]));
    }
  }
  return result;
}

function AgentMessageList({
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
  conversationId: conversationIdProp,
  foldTurns: foldTurnsProp,
}: Props) {
  // 分页展示条数，默认展示最近 PAGE_SIZE 条
  const [visibleCount, setVisibleCount] = useState(() =>
    Math.min(messages.length, PAGE_SIZE),
  );

  // 会话切换探测标识（按首条消息 id 判定会话切换，避免新增尾部消息时重置分页与视口）
  const conversationKey = messages[0]?.id ?? "";
  const lastConversationKeyRef = useRef(conversationKey);
  const prevMessagesLengthRef = useRef(messages.length);

  // 滚动容器与锚定位置记忆
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  const contentWrapperRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const scrollSnapshotRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);

  // 标记是否处于贴底锁定状态（会话初次进入或用户位于底部时为 true）
  const isPinnedToBottomRef = useRef(true);

  // 辅助获取最近的滚动父容器
  const getScrollContainer = useCallback(() => {
    if (scrollContainerRef.current && scrollContainerRef.current.isConnected) {
      return scrollContainerRef.current;
    }
    const target =
      contentWrapperRef.current ??
      topSentinelRef.current ??
      bottomSentinelRef.current;
    const container =
      (target?.closest(".overflow-y-auto") as HTMLElement | null) ??
      target?.parentElement;
    if (container) scrollContainerRef.current = container;
    return container;
  }, []);

  // 会话切换时重置分页窗口；同一个会话新增消息时，窗口顺延扩展保证最新消息能可见
  useEffect(() => {
    if (lastConversationKeyRef.current !== conversationKey) {
      lastConversationKeyRef.current = conversationKey;
      prevMessagesLengthRef.current = messages.length;
      setVisibleCount(Math.min(messages.length, PAGE_SIZE));
      if (!highlightMessageId) {
        isPinnedToBottomRef.current = true;
      }
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
  }, [conversationKey, messages.length, highlightMessageId]);

  // 搜索或高亮定位的消息如果在未加载的更早历史中，自动展开到包含该消息
  useEffect(() => {
    if (!highlightMessageId) return;
    isPinnedToBottomRef.current = false;
    const targetIdx = messages.findIndex((m) => m.id === highlightMessageId);
    if (targetIdx !== -1) {
      const neededCount = messages.length - targetIdx + 10; // 额外增加缓冲区
      setVisibleCount((prev) => (neededCount > prev ? Math.min(messages.length, neededCount) : prev));
    }
  }, [highlightMessageId, messages]);

  // 截取尾部可见消息；窗口起点对齐到 user 边界（回合折叠的稳定性关键）：
  // 若起点切在某个回合中间（首条非 user），该回合会被 segmentTurns 判成
  // “半截”而展开；翻页后 user 补进窗口，同一回合又变完整 → 折叠，产生
  // “下面的消息突然折叠”的突变。向前多取到该 user，让窗口内的起始回合
  // 从第一次渲染起就是完整的，折叠判定跨翻页稳定。
  const effectiveVisibleCount = Math.min(messages.length, Math.max(PAGE_SIZE, visibleCount));
  const hasMore = messages.length > effectiveVisibleCount;
  const slicedMessages = useMemo(() => {
    if (!hasMore) return messages;
    const start = alignedWindowStart(messages, effectiveVisibleCount);
    return messages.slice(start);
  }, [messages, effectiveVisibleCount, hasMore]);

  const activeConversationId = useConversationStore((s) => s.activeConversationId);
  // 本列表所属对话：显式传入优先（历史浏览等非活跃列表必须传），否则活跃对话。
  const listConversationId = conversationIdProp ?? activeConversationId ?? "";

  // 设置：折叠已完成长回合（列表级 foldTurns=false（历史只读/检索）恒不折叠；
  // 否则跟随全局设置，默认开）。
  const globalFoldTurns = useSettingsStore(
    (s) => s.settings.foldCompletedTurns ?? true,
  );
  const foldTurns = foldTurnsProp ?? globalFoldTurns;
  // 尾回合「任务在跑」：本对话下是否有 running task（主 agent 或子 agent）。
  // 正在跑的任务回合永不折叠 —— 模型可能在 tool 间继续输出，现在收起就是
  // “干一半收起”。响应式：任务状态变化触发重算。
  const tailActive = useTaskStore(
    (s) => listConversationId !== ""
      && Object.values(s.tasks).some(
        (t) =>
          t.conversationId === listConversationId &&
          !!t.sessionId &&
          (t.status === "planning"
            || t.status === "executing"
            || t.status === "waiting_approval"),
      ),
  );
  const renderItems = useMemo(
    () => (foldTurns
      ? buildTurnItems(slicedMessages, tailActive)
      : buildGroupedItems(slicedMessages)),
    [slicedMessages, foldTurns, tailActive],
  );
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const matchedSet = useMemo(
    () => new Set(matchedMessageIds ?? []),
    [matchedMessageIds],
  );
  const [flashId, setFlashId] = useState<string | null>(null);

  const hasEarlierMessages = useConversationStore((s) =>
    activeConversationId ? (s.hasEarlierMessages[activeConversationId] ?? false) : false,
  );
  const loadEarlierHistory = useConversationStore((s) => s.loadEarlierHistory);

  // 加载上一页消息并执行滚动位置锚定
  const loadMoreEarlierMessages = useCallback(() => {
    const container = getScrollContainer();
    if (container) {
      scrollSnapshotRef.current = {
        scrollHeight: container.scrollHeight,
        scrollTop: container.scrollTop,
      };
    }

    if (hasMore) {
      setVisibleCount((prev) => Math.min(messages.length, prev + PAGE_SIZE));
    } else if (hasEarlierMessages && activeConversationId) {
      // 内存消息已全部展示，若后端 Checkpoint 前还有更早归档历史，按需拉取补齐
      void loadEarlierHistory(activeConversationId).then(() => {
        setVisibleCount((prev) => prev + PAGE_SIZE);
      });
    }
  }, [hasMore, hasEarlierMessages, activeConversationId, getScrollContainer, messages.length, loadEarlierHistory]);

  // 在 DOM 增加较早消息后同步补齐滚动高度，保持视口绝对内容平滑不动
  useIsomorphicLayoutEffect(() => {
    const snapshot = scrollSnapshotRef.current;
    const container = getScrollContainer();
    if (!snapshot || !container) return;

    const delta = container.scrollHeight - snapshot.scrollHeight;
    if (delta > 0) {
      container.scrollTop = snapshot.scrollTop + delta;
    }
    scrollSnapshotRef.current = null;
  }, [slicedMessages, getScrollContainer]);

  // 会话切换/首次渲染时的即时贴底（在 DOM 变更后绘制前同步校准）
  useIsomorphicLayoutEffect(() => {
    if (highlightMessageId) return;
    if (isPinnedToBottomRef.current) {
      const container = getScrollContainer();
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    }
  }, [conversationKey, slicedMessages, highlightMessageId, getScrollContainer]);

  // 监听容器滚动事件：用户离开底部时解除贴底锁定，滑回底部时重新锁定
  useEffect(() => {
    const container = getScrollContainer();
    if (!container) return;

    const handleScroll = () => {
      const near = isNearBottom(
        container.scrollTop,
        container.clientHeight,
        container.scrollHeight,
        120,
      );
      isPinnedToBottomRef.current = near;
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [getScrollContainer]);

  const canLoadEarlier = hasMore || hasEarlierMessages;

  // 顶部哨兵自动续载（死锁兜底）：向上翻页靠哨兵 IO 的 crossing 触发，
  // 但一批新消息若全是已完成回合折叠出的矮行（几十 px），滚动锚定后哨兵
  // 仍停在容器顶部检测带内，IO 不会再有 crossing → “加载更早消息...”永久
  // 空转、怎么等都不加载。这里在每次布局后复查：哨兵还在检测带内且仍有
  // 更早内容 → 让出浏览器一帧（rAF，避免同帧同步循环）续下一批，直到哨兵
  // 被顶出检测带或没有更早消息可载为止；批高正常时哨兵一次即被顶出，
  // 行为与原来完全一致。
  const topLoadPendingRef = useRef(false);
  const latestLoadMoreRef = useRef(loadMoreEarlierMessages);
  latestLoadMoreRef.current = loadMoreEarlierMessages;
  const latestCanLoadEarlierRef = useRef(canLoadEarlier);
  latestCanLoadEarlierRef.current = canLoadEarlier;

  useIsomorphicLayoutEffect(() => {
    if (!latestCanLoadEarlierRef.current || topLoadPendingRef.current) return;
    const container = getScrollContainer();
    const sentinel = topSentinelRef.current;
    if (!container || !sentinel) return;
    const containerRect = container.getBoundingClientRect();
    const sentinelRect = sentinel.getBoundingClientRect();
    // 哨兵底边仍在容器顶部检测带内（可见或贴邻上方）才视为“停驻待续载”
    if (sentinelRect.bottom < containerRect.top - TOP_SENTINEL_MARGIN) return;

    topLoadPendingRef.current = true;
    requestAnimationFrame(() => {
      topLoadPendingRef.current = false;
      if (!latestCanLoadEarlierRef.current) return;
      latestLoadMoreRef.current();
    });
  }, [slicedMessages, canLoadEarlier, getScrollContainer]);

  // 监听顶部哨兵元素进行触顶自动加载
  useEffect(() => {
    if (!canLoadEarlier) return;
    const sentinel = topSentinelRef.current;
    if (!sentinel) return;

    const container = getScrollContainer();
    const observer = new IntersectionObserver(
      (entries) => {
        const first = entries[0];
        if (first?.isIntersecting) {
          loadMoreEarlierMessages();
        }
      },
      {
        root: container,
        rootMargin: `${TOP_SENTINEL_MARGIN}px 0px 0px 0px`, // 提前 160px 预加载，保证无缝滚动
        threshold: 0.01,
      },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [canLoadEarlier, getScrollContainer, loadMoreEarlierMessages]);

  // 监听内容尺寸变化（例如 iframe 异步测高撑开、图片加载等）：若用户处于贴底锁定区，则自动保持贴底
  useEffect(() => {
    const wrapper = contentWrapperRef.current;
    if (!wrapper || typeof ResizeObserver === "undefined") return;

    let rafId: number | null = null;
    const ro = new ResizeObserver(() => {
      // rAF 合并：拖动 agent 栏宽度时消息内容每帧都可能尺寸变化，
      // 直接设 scrollTop 会每帧强制 reflow，多个尺寸源叠加会把主线程打满。
      if (rafId != null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const container = getScrollContainer();
        if (!container) return;
        if (!highlightMessageId && isPinnedToBottomRef.current) {
          container.scrollTop = container.scrollHeight;
        }
      });
    });

    ro.observe(wrapper);
    return () => {
      if (rafId != null) cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, [getScrollContainer, highlightMessageId]);

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

  // 渲染单条消息（普通路径，含展开宽度/高亮；用于可见消息）。
  const renderOne = useCallback(
    (msg: AgentMessage): ReactNode => {
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
    },
    // wrapMessage 引用的 flashId/matchedSet 属父级状态；折叠区命中时由
    // forceExpand 展开，故这里不需要它们进依赖（普通路径在父级每次渲染时
    // 重建也无妨——它只影响可见行，不触发折叠区）。依赖保持最小：
    // expandedIds/isThinking/isRunning 变化才重建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [expandedIds, isThinking, isRunning, onRollback, onCopy, searchKeyword, alwaysShowActions],
  );

  const conversationId = activeConversationId ?? "";
  return (
    <div
      ref={contentWrapperRef}
      className="flex flex-col space-y-1 min-w-0 w-full"
    >
      {canLoadEarlier && (
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
      {renderItems.map((item) => {
        if ("kind" in item && item.kind === "turn-fold") {
          const seg = item.segment;
          const forceExpand = seg.foldMembers.some(
            (m) => matchedSet.has(m.id) || m.id === highlightMessageId,
          );
          // user / 答案恒定渲染（普通路径）；过程内容惰性构建：
          // 先对 foldMembers 做探索/plan 组折叠，展开时才逐条渲染。
          const userMsg = seg.messages[0];
          const answerMsg = seg.answerIndex === null
            ? null
            : seg.messages[seg.answerIndex];
          return (
            <TurnFoldGroup
              key={`turn-${seg.key}`}
              conversationId={conversationId}
              segment={seg}
              renderUser={() => (userMsg ? renderOne(userMsg) : null)}
              renderAnswer={() => (answerMsg ? renderOne(answerMsg) : null)}
              renderExpanded={() => {
                const inner = buildGroupedItems(
                  seg.foldMembers as AgentMessage[],
                );
                return inner.map((it) => {
                  // buildGroupedItems 不会产出 turn-fold；此处按组/单条分派。
                  if (it && typeof it === "object" && "kind" in it) {
                    const group = it as Extract<RenderItem, { kind: ToolGroupKind }>;
                    return (
                      <ExplorationGroup
                        key={`${group.kind}-${group.tools[0].id}`}
                        kind={group.kind}
                        messages={group.tools}
                        autoExpand={false}
                        matchedIds={matchedSet}
                        flashId={flashId}
                      />
                    );
                  }
                  // 展开后即普通可见消息 → 走完整渲染（高亮/复制/回滚一致）。
                  return renderOne(it as AgentMessage);
                });
              }}
              forceExpand={forceExpand}
            />
          );
        }
        if ("kind" in item) {
          return (
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
          );
        }
        return renderOne(item);
      })}
      <div ref={bottomSentinelRef} className="h-0 w-0 pointer-events-none" />
      {messagesEndRef && <div ref={messagesEndRef} />}
    </div>
  );
}

// memo：输入框每敲一个字（inputDraft 变化）父组件会重渲染，但 messages 等
// props 引用不变时整棵消息树（含 HtmlVisualization/长文本）应完全跳过。
// 否则消息多 + 重型可视化时打字明显卡顿。
export default memo(AgentMessageList);
