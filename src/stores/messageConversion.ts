import type { StoredMessage, AgentMessage, RiskLevel } from '@/lib/types';

// ───────────────────────── Conversion Strategies ─────────────────────────

/** Strategy interface for converting StoredMessage to AgentMessage */
interface MessageConversionStrategy {
  /** Check if this strategy can handle the given message */
  canHandle(message: StoredMessage): boolean;
  /** Convert the message, returning the modified base message */
  convert(message: StoredMessage, base: AgentMessage): AgentMessage;
}

/** Helper: extract tool name from legacy content format like "[tool_name] result" */
function extractLegacyToolName(content: string): string {
  const match = content.match(/^\[(\w+)\]\s/);
  return match ? match[1] : 'execute_command';
}

/** Helper: generate summary from content, truncating if needed */
function generateSummary(content: string, maxLength: number = 60): string {
  if (!content) return '(done)';
  return content.length > maxLength ? content.slice(0, maxLength) + '...' : content;
}

/** Helper: check if content indicates a blocked command */
function isBlockedContent(content: string): boolean {
  return content.startsWith('BLOCKED:');
}

/** Helper: check if content indicates a tool error */
function isErrorContent(content: string): boolean {
  return content.startsWith('tool error:');
}

/** Helper: determine success status from content */
function determineSuccess(content: string): boolean {
  return !isBlockedContent(content) && !isErrorContent(content);
}

// ───────────────────────── Legacy Tool Result Strategy ─────────────────────────

/** Handles tool role messages without toolCallsJson (legacy data) */
class LegacyToolResultStrategy implements MessageConversionStrategy {
  canHandle(message: StoredMessage): boolean {
    return message.role === 'tool' && !message.toolCallsJson;
  }

  convert(message: StoredMessage, base: AgentMessage): AgentMessage {
    const content = message.content || '';
    const toolName = extractLegacyToolName(content);

    base.toolResult = {
      toolName,
      summary: generateSummary(content, 60),
      result: content,
      success: determineSuccess(content),
      blocked: isBlockedContent(content),
    };

    return base;
  }
}

// ───────────────────────── Assistant Message Strategy ─────────────────────────

/** Handles assistant messages with toolCallsJson containing tool call info */
class AssistantMessageStrategy implements MessageConversionStrategy {
  canHandle(message: StoredMessage): boolean {
    return message.role === 'assistant' && !!message.toolCallsJson;
  }

  convert(message: StoredMessage, base: AgentMessage): AgentMessage {
    try {
      const raw = JSON.parse(message.toolCallsJson!);
      const persistedCalls: Array<{
        id: string;
        name: string;
        arguments: Record<string, unknown>;
        risk_level?: RiskLevel;
      }> = Array.isArray(raw) ? raw : [raw];

      if (persistedCalls.length > 0) {
        // 只填 toolCalls（复数），供 buildLlmHistory 跨 task 还原并行调用。
        // 不设 toolCall：AgentMessageList 会对 assistant+toolCall 再渲一张 ToolCallCard，
        // 与后续 role=tool 卡片重复，且会盖住 assistant 文案。
        base.toolCalls = persistedCalls.map((c) => ({
          id: c.id,
          name: c.name,
          arguments: c.arguments || {},
          riskLevel: c.risk_level || ('Moderate' as RiskLevel),
        }));
      }
    } catch {
      // 解析失败则返回不含 tool 信息的 base 消息
    }

    return base;
  }
}

// ───────────────────────── Tool Result Strategy ─────────────────────────

/** Handles tool role messages with toolCallsJson (new and legacy formats) */
class ToolResultStrategy implements MessageConversionStrategy {
  canHandle(message: StoredMessage): boolean {
    return message.role === 'tool' && !!message.toolCallsJson;
  }

  convert(message: StoredMessage, base: AgentMessage): AgentMessage {
    try {
      const raw = JSON.parse(message.toolCallsJson!);

      // New format: PersistedToolResult with name/summary/success/blocked
      if (this.isNewFormat(raw)) {
        return this.convertNewFormat(raw, message, base);
      }

      // Legacy format: PersistedToolCall[] array
      if (this.isLegacyFormat(raw)) {
        return this.convertLegacyFormat(raw, message, base);
      }
    } catch {
      // Ignore parse error - return base message without tool result info
    }

    return base;
  }

  private isNewFormat(raw: unknown): raw is {
    id?: string;
    name: string;
    arguments?: Record<string, unknown>;
    risk_level?: RiskLevel;
    summary?: string;
    success?: boolean;
    blocked?: boolean;
  } {
    return (
      typeof raw === 'object' &&
      raw !== null &&
      'name' in raw &&
      typeof (raw as Record<string, unknown>).name === 'string'
    );
  }

  private isLegacyFormat(raw: unknown): raw is Array<{
    id?: string;
    name: string;
    arguments?: Record<string, unknown>;
    risk_level?: RiskLevel;
  }> {
    return Array.isArray(raw) && raw.length > 0 && typeof raw[0].name === 'string';
  }

  private convertNewFormat(
    tr: {
      id?: string;
      name: string;
      arguments?: Record<string, unknown>;
      risk_level?: RiskLevel;
      summary?: string;
      success?: boolean;
      blocked?: boolean;
      was_timeout?: boolean;
      was_aborted?: boolean;
    },
    message: StoredMessage,
    base: AgentMessage
  ): AgentMessage {
    base.toolResult = {
      toolName: tr.name,
      summary: tr.summary || generateSummary(message.content, 120),
      result: message.content,
      success: tr.success ?? true,
      blocked: tr.blocked ?? false,
      wasTimeout: tr.was_timeout,
      wasAborted: tr.was_aborted,
      arguments: tr.arguments,
      toolCallId: tr.id,
    };
    return base;
  }

  private convertLegacyFormat(
    raw: Array<{
      id?: string;
      name: string;
      arguments?: Record<string, unknown>;
      risk_level?: RiskLevel;
    }>,
    message: StoredMessage,
    base: AgentMessage
  ): AgentMessage {
    base.toolResult = {
      toolName: raw[0].name,
      summary: generateSummary(message.content, 120),
      result: message.content,
      success: determineSuccess(message.content),
      blocked: isBlockedContent(message.content),
      arguments: raw[0].arguments,
      toolCallId: raw[0].id,
    };
    return base;
  }
}

// ───────────────────────── Strategy Registry ─────────────────────────

/** Registry of all conversion strategies, ordered by priority */
const conversionStrategies: MessageConversionStrategy[] = [
  new LegacyToolResultStrategy(),
  new AssistantMessageStrategy(),
  new ToolResultStrategy(),
];

// ───────────────────────── Public API ─────────────────────────

/**
 * Deserialize a StoredMessage into an AgentMessage, reconstructing toolCall info if present.
 *
 * This function uses a strategy pattern to handle different message formats:
 * - Legacy tool results (no toolCallsJson)
 * - Assistant messages with tool call info
 * - Tool results with new format (PersistedToolResult)
 * - Tool results with legacy format (PersistedToolCall[])
 */
export function storedMessageToAgentMessage(m: StoredMessage): AgentMessage {
  const base: AgentMessage = {
    id: m.id,
    role: m.role as AgentMessage['role'],
    content: m.content,
    timestamp: m.timestamp,
    reasoningContent: m.reasoningContent || undefined,
  };

  for (const strategy of conversionStrategies) {
    if (strategy.canHandle(m)) {
      return strategy.convert(m, base);
    }
  }

  return base;
}

/**
 * Post-process loaded messages to strip reasoningContent from assistant messages
 * that are immediately followed by a tool card.
 *
 * This mirrors the live-streaming behaviour where handleToolCallStart clears the
 * thinking before a tool executes.  Old DB rows (written before the fix) may still
 * carry reasoning_content for these intermediate assistant messages; this function
 * cleans them up so the UI matches what streaming would have shown.
 */
export function clearIntermediateReasoning(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((msg, i) => {
    if (msg.role !== 'assistant' || !msg.reasoningContent) return msg;
    const next = messages[i + 1];
    if (!next) return msg;
    const nextIsTool =
      (next.role === 'tool' && !!next.toolResult) ||
      (next.role === 'assistant' && (!!next.toolCall || !!next.toolCalls?.length));
    if (!nextIsTool) return msg;
    return { ...msg, reasoningContent: undefined, isThinking: false };
  });
}
