import type { StoredMessage, AgentMessage, RiskLevel } from '@/lib/types';

// ───────────────────────── Conversion Strategies ─────────────────────────

/** 压缩摘要落库消息的前缀（save_msg 的 display 格式，见 agent_loop / agent_compact）。 */
const COMPACTION_SUMMARY_PREFIX = '【上下文已压缩】';
/** 标题行统计：已整理 N 条历史消息（约 M tokens） */
const COMPACTION_HEADER_RE = /已整理\s*(\d+)\s*条历史消息（约\s*(\d+)\s*tokens）/;

/**
 * 识别落库的压缩摘要 system 消息，还原为卡片展示数据（CompactionCard）。
 *
 * 压缩成功后后端 `save_msg("system", display)` 落库的展示消息只有
 * `role=system + content`（display = 标题行 + 空行 + 摘要），没有
 * `compaction` 字段——那是前端内存展示态。从 DB 重载时若不还原，
 * 该消息会退化为纯文本（居中灰字）。这里解析出统计与摘要，构造
 * `compaction = { status: 'done', ... }`，使重载后与压缩完成时的
 * 卡片一致。解析失败（格式异常/旧数据）时安全降级：统计缺失则卡片
 * 不显示统计，摘要缺失则不展开内容。
 */
function parseCompactionSummary(content: string): AgentMessage['compaction'] | undefined {
  if (!content.startsWith(COMPACTION_SUMMARY_PREFIX)) return undefined;
  const newline = content.indexOf('\n');
  const header = newline === -1 ? content : content.slice(0, newline);
  const summary = newline === -1 ? '' : content.slice(newline + 1).trimStart();
  const match = header.match(COMPACTION_HEADER_RE);
  return {
    status: 'done',
    ...(summary ? { summary } : {}),
    ...(match
      ? {
          shadowedMessages: Number(match[1]),
          shadowedTokens: Number(match[2]),
        }
      : {}),
  };
}

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
    metadata?: Record<string, unknown>;
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
      metadata?: Record<string, unknown>;
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
      metadata: tr.metadata,
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
function parseImagePaths(json?: string | null): string[] | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
      return parsed.length > 0 ? parsed : undefined;
    }
  } catch {
    // ignore corrupt legacy data
  }
  return undefined;
}

export function storedMessageToAgentMessage(m: StoredMessage): AgentMessage {
  const base: AgentMessage = {
    id: m.id,
    role: m.role as AgentMessage['role'],
    content: m.content,
    timestamp: m.timestamp,
    reasoningContent: m.reasoningContent || undefined,
    imagePaths: parseImagePaths(m.imagePathsJson),
  };

  // 压缩摘要落库消息：还原为 CompactionCard 展示（done 卡，默认展开摘要）
  const compaction = parseCompactionSummary(m.content);
  if (compaction) {
    base.compaction = compaction;
  }

  for (const strategy of conversionStrategies) {
    if (strategy.canHandle(m)) {
      return strategy.convert(m, base);
    }
  }

  return base;
}

/**
 * Post-process loaded messages to strip the live "thinking" flag from assistant
 * messages that are immediately followed by a tool card.
 *
 * This mirrors the live-streaming behaviour where handleToolCallStart clears the
 * thinking before a tool executes.  Old DB rows (written before the fix) may still
 * carry reasoning_content for these intermediate assistant messages; this function
 * cleans up the UI flag so the UI matches what streaming would have shown.
 *
 * reasoningContent 字段本身保留：DeepSeek thinking 模式要求带 tool_calls 的
 * assistant 消息回传 reasoning_content，重载后缺失会 400。UI 是否展示由
 * AgentMessage 的 hasReasoning（含 toolCalls 条件）与 isThinking 控制，
 * 保留字段不影响展示。
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
    // 只清显示标志，保留 reasoningContent 供 LLM 回传
    return { ...msg, isThinking: false };
  });
}

// ───────────────────────── 压缩视图重建（原位替换 + 重启回放） ─────────────────────────

/** 镜像 summarizer.rs 的 CHECKPOINT_PREAMBLE（保持逐字节一致；改后端时同步这里）。 */
export const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.';

const SUMMARY_OPEN_TAG = '<compacted-summary>';
const SUMMARY_CLOSE_TAG = '</compacted-summary>';

export type CompactionRole = 'user' | 'assistant' | 'tool';

/**
 * history-relevant 投影：跳过 loading 与 system 通知/运行中卡（非 done 压缩卡）；
 * done 压缩卡计入投影并归一化为 user 角色（对应后端 loop 缓冲里被压区间的
 * framed checkpoint user 消息，两者每条压缩各占一个投影位）。
 */
export function historyRelevantMessages(
  msgs: AgentMessage[],
): Array<{ m: AgentMessage; i: number }> {
  return msgs
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => !m.isLoading && !(m.role === 'system' && m.compaction?.status !== 'done'));
}

/** 角色归一化：done 压缩卡 → user（loop 的 framed checkpoint）；其余取原角色。 */
export function compactionNormalizedRole(m: AgentMessage): CompactionRole {
  if (m.role === 'system' && m.compaction?.status === 'done') return 'user';
  if (m.role === 'user' || m.role === 'assistant' || m.role === 'tool') return m.role;
  return 'user'; // 兜底（正常数据不应出现）
}

/** 后端 Done 事件携带的被压区间校验信息。 */
export interface CompactionSpanSpec {
  /** 区间在投影中的起点。 */
  start: number;
  /** 区间长度（= shadowedMessages）。 */
  count: number;
  /** 角色序列（保序）。 */
  roles: CompactionRole[];
  /** tool 消息 toolCallId 序列（保序，仅 tool 消息）。 */
  toolIds: Array<string | null>;
}

export interface CompactionSpliceResult {
  msgs: AgentMessage[];
  removedIds: string[];
  applied: boolean;
}

/**
 * 原位替换：校验（数量不越界 + 角色序列一致 + tool 调用 id 序列一致）全部通过
 * 才删被压消息、原位插入 done 卡；任一不匹配 → 不动任何消息（applied=false），
 * 由调用方降级（卡片留在尾部）。幂等：重复应用时区间已被替换 → 校验失败 → no-op。
 * 注：持久化由后端结构化落库（count-walk + 指纹校验 + 归档），本函数只负责
 * live store 视图；被压 id 仅用于删除，不落库。
 */
export function applyCompactionSplice(
  msgs: AgentMessage[],
  span: CompactionSpanSpec,
  card: AgentMessage,
  runningCardId?: string | null,
): CompactionSpliceResult {
  const proj = historyRelevantMessages(msgs);
  if (span.start + span.count > proj.length) {
    return { msgs, removedIds: [], applied: false };
  }
  const slice = proj.slice(span.start, span.start + span.count);
  const roles = slice.map(({ m }) => compactionNormalizedRole(m));
  const toolIds = slice
    .filter(({ m }) => m.role === 'tool')
    .map(({ m }) => m.toolResult?.toolCallId ?? null);
  if (roles.length !== span.roles.length || roles.some((r, i) => r !== span.roles[i])) {
    return { msgs, removedIds: [], applied: false };
  }
  if (
    toolIds.length !== span.toolIds.length ||
    toolIds.some((id, i) => id !== span.toolIds[i])
  ) {
    return { msgs, removedIds: [], applied: false };
  }

  const removedIds = slice.map((p) => p.m.id);
  const drop = new Set(removedIds);
  if (runningCardId) drop.add(runningCardId);
  const insertAt = slice[0].i;
  const out = msgs.filter((m) => !drop.has(m.id));
  out.splice(insertAt, 0, card);
  return { msgs: out, removedIds, applied: true };
}

/** done 压缩卡 → user 角色 checkpoint（framing 与后端逐字节一致，二次压缩的
 *  PRIOR checkpoint 识别依赖它）；非 done / 无摘要 → null。 */
export function compactionCheckpoint(
  card: AgentMessage,
): { role: 'user'; content: string } | null {
  if (card.compaction?.status !== 'done') return null;
  const summary = card.compaction.summary;
  if (!summary) return null;
  return {
    role: 'user',
    content: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}\n${summary}\n${SUMMARY_CLOSE_TAG}`,
  };
}
