import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import type { AgentMessage } from '@/lib/types';
import AgentMessageItem from './AgentMessage';
import ToolCallCard from './ToolCallCard';
import ExplorationGroup, { isExplorationTool } from './ExplorationGroup';

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

function buildRenderItems(messages: AgentMessage[]) {
  const result: (
    | AgentMessage
    | { kind: 'exploration'; tools: AgentMessage[] }
  )[] = [];
  const visibleMessages = messages.filter((msg) => {
    if (msg.role !== 'assistant') return true;
    return msg.isLoading || msg.content || msg.reasoningContent || msg.toolCall;
  });
  const n = visibleMessages.length;
  let i = 0;
  while (i < n) {
    if (isExplorationTool(visibleMessages[i])) {
      let j = i;
      while (j < n && isExplorationTool(visibleMessages[j])) j++;
      if (j - i >= 4) {
        result.push({
          kind: 'exploration',
          tools: visibleMessages.slice(i, j),
        });
        i = j;
        continue;
      }
    }
    result.push(visibleMessages[i]);
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
  const renderItems = useMemo(() => buildRenderItems(messages), [messages]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const matchedSet = useMemo(
    () => new Set(matchedMessageIds ?? []),
    [matchedMessageIds],
  );
  const [flashId, setFlashId] = useState<string | null>(null);

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
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
          isFlash ? 'bg-indigo-500/20 ring-1 ring-indigo-400/30' : ''
        } ${isMatch ? 'pl-2' : ''}`}
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
      {renderItems.map((item) =>
        'kind' in item && item.kind === 'exploration' ? (
          <ExplorationGroup
            key={`exploration-${item.tools[0].id}`}
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
            if (
              (msg.role === 'tool' && msg.toolResult) ||
              (msg.role === 'assistant' && msg.toolCall)
            ) {
              return wrapMessage(
                msg,
                <div className="flex justify-start min-w-0">
                  <div
                    className={`min-w-0 ${expandedIds.has(msg.id) ? 'w-full' : 'max-w-[85%]'}`}
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
