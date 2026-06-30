import { useMemo, type RefObject } from 'react';
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
}

function buildRenderItems(messages: AgentMessage[]) {
  const result: (AgentMessage | { kind: 'exploration'; tools: AgentMessage[] })[] = [];
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
        result.push({ kind: 'exploration', tools: visibleMessages.slice(i, j) });
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
}: Props) {
  const renderItems = useMemo(() => buildRenderItems(messages), [messages]);

  return (
    <>
      {renderItems.map((item) =>
        'kind' in item && item.kind === 'exploration' ? (
          <ExplorationGroup
            key={`exploration-${item.tools[0].id}`}
            messages={item.tools}
            autoExpand={isThinking}
          />
        ) : (() => {
          const msg = item as AgentMessage;
          return (msg.role === 'tool' && msg.toolResult) ||
            (msg.role === 'assistant' && msg.toolCall) ? (
            <div key={msg.id} className="flex justify-start">
              <div className="max-w-[85%]">
                <ToolCallCard message={msg} autoExpand={isThinking} />
              </div>
            </div>
          ) : (
            <AgentMessageItem
              key={msg.id}
              message={msg}
              autoExpand={!!msg.isThinking}
              rollbackDisabled={isRunning}
              onRollback={onRollback}
              onCopy={onCopy}
            />
          );
        })()
      )}
      {messagesEndRef && <div ref={messagesEndRef} />}
    </>
  );
}
