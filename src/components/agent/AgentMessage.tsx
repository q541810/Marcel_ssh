import { Check, ChevronDown, ChevronRight, Copy, Undo2 } from 'lucide-react';
import { memo, useMemo, useState, useEffect, useRef, type ReactNode } from 'react';
import type { AgentMessage as AgentMessageType } from '@/lib/types';
import UserMessageAttachments from './UserMessageAttachments';
import SkillChips from './SkillChips';
import { validateUserInput } from '@/lib/userInput';
import MarkdownBody from './MarkdownBody';
import { useMessageViewState } from './messageViewState';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  useIsomorphicLayoutEffect,
  useStickyFollow,
} from '@/hooks/useStickyFollow';
import { INNER_FOLLOW_THRESHOLD_PX } from '@/lib/agentScroll';
import { parseJobNotice } from '@/lib/jobNotice';
import { useJobStore } from '@/stores/jobStore';
import { ToolCardFrame, type ToolCardTone } from './toolCardChrome';
import 'katex/dist/katex.min.css';

interface Props {
  message: AgentMessageType;
  autoExpand?: boolean;
  rollbackDisabled?: boolean;
  onRollback?: (message: AgentMessageType) => void;
  onCopy?: (message: AgentMessageType) => void;
  /** 搜索关键词：用户消息正文高亮 */
  searchKeyword?: string;
  /** 触屏端无 hover：时间/撤回/复制操作行常显 */
  alwaysShowActions?: boolean;
}

function highlightPlainText(text: string, keyword?: string): ReactNode {
  const q = keyword?.trim();
  if (!q) return text;
  const lower = text.toLowerCase();
  const qLower = q.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const idx = lower.indexOf(qLower, i);
    if (idx < 0) {
      parts.push(text.slice(i));
      break;
    }
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(
      <mark
        key={key++}
        className="rounded bg-indigo-400/30 text-indigo-100 px-0.5"
      >
        {text.slice(idx, idx + q.length)}
      </mark>,
    );
    i = idx + q.length;
  }
  return parts.length ? parts : text;
}

const MARKDOWN_CLASS =
  'text-read text-fg break-words prose marcel-prose prose-sm max-w-none prose-p:my-0.5 prose-code:text-[var(--marcel-md-code-text)] prose-code:bg-surface prose-code:px-1 prose-code:py-0.5 prose-code:rounded-lg prose-code:before:content-none prose-code:after:content-none prose-pre:bg-surface prose-pre:border prose-pre:border-edge prose-a:text-indigo-400 prose-headings:my-2 prose-ul:my-0 prose-ol:my-0 prose-li:my-0 prose-blockquote:border-l-edge-strong prose-blockquote:text-fg-secondary prose-blockquote:italic [&_.katex-display]:my-2 [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex-display]:py-0.5 [&_.katex]:text-fg [&_.katex-error]:text-red-400 [&_.katex-error]:text-[0.9em]';

// ─── Retry indicator ───
// 后端发完 Retrying 事件就 sleep，前端基于消息 timestamp + retryTotalDelaySecs
// 自己算剩余秒数，区分"等待"和"正在重试"两个阶段。
//
// 设计（用户视角）：断线重试是「系统在自己处理」的事，不该吓人也不该抢眼——
// 1. 已经上屏的半截文字**不立刻消失**，淡淡地留在原处（用户读到一半的东西不被抽走），
//    下面一行灰字交代「网络中断，正在重新连接…（第 N 次）」；重试后的新输出开始上屏时，
//    这条指示消息被撤掉，半截文字随之被真正的输出替换（`agentStreamHandlers` 保证半截
//    从不入库、不进模型历史、不会和新输出重复）。
// 2. 全程中性灰，没有琥珀 / 天蓝的胶囊；重试耗尽走后面的「LLM 错误」系统消息，那才是错误态。
// 3. 底层的英文错误（HTTP 429 …）默认不显示，收在「详情」里，要看才点开。
function RetryIndicator({ message }: { message: AgentMessageType }) {
  const attempt = Math.max(message.retryAttempt ?? 0, 1);
  const maxAttempts = message.retryMaxAttempts ?? 0;
  const totalDelay = message.retryTotalDelaySecs ?? 0;
  const lastError = (message.retryLastError ?? '').trim();
  const partial = message.retryPartialText ?? '';
  const midStream = message.retryMidStream === true || !!partial;

  const startMs = new Date(message.timestamp).getTime();
  const endMs = startMs + totalDelay * 1000;

  const [remaining, setRemaining] = useState(() => {
    const r = (endMs - Date.now()) / 1000;
    return r > 0 ? r : 0;
  });
  const [detailsOpen, setDetailsOpen] = useMessageViewState('retry-details-open', false);
  const endMsRef = useRef(endMs);
  endMsRef.current = endMs;

  useEffect(() => {
    const tick = () => {
      const r = (endMsRef.current - Date.now()) / 1000;
      setRemaining(r > 0 ? r : 0);
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, []);

  const waiting = remaining > 0;
  const remainingCeil = Math.ceil(remaining);
  const nth = `（第 ${attempt} 次）`;
  const lead = midStream ? '网络中断' : '请求失败';
  const line = waiting
    ? `${lead}，${remainingCeil} 秒后${midStream ? '重新连接' : '重试'}…${nth}`
    : `${lead}，正在${midStream ? '重新连接' : '重试'}…${nth}`;

  return (
    <div className="my-1 flex justify-start" data-testid="retry-indicator">
      <div className="min-w-0 max-w-[90%]">
        {partial && (
          // 被丢弃的半截正文：淡出留在原处，不可选中 / 不可交互——它只是「刚才读到哪」的参照
          <div
            data-testid="retry-partial"
            aria-hidden="true"
            className={`${MARKDOWN_CLASS} pointer-events-none select-none opacity-40`}
          >
            <MarkdownBody content={partial} />
          </div>
        )}
        <div className="flex min-w-0 items-center gap-1.5 text-meta text-fg-tertiary" role="status">
          {waiting ? (
            <svg className="h-3 w-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="9" strokeWidth={2} />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 7v5l3 2" />
            </svg>
          ) : (
            <svg className="h-3 w-3 flex-shrink-0 animate-spin motion-reduce:animate-none" fill="none" viewBox="0 0 24 24" aria-hidden="true">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          )}
          <span className="min-w-0">{line}</span>
          {lastError && (
            <button
              type="button"
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen((v) => !v)}
              className="flex-shrink-0 rounded px-1 text-fg-tertiary underline-offset-2 transition-colors hover:text-fg-secondary hover:underline [@media(pointer:coarse)]:py-1.5"
            >
              详情
            </button>
          )}
        </div>
        {lastError && detailsOpen && (
          <div
            data-testid="retry-details"
            className="mt-0.5 max-w-full break-words text-caption text-fg-tertiary [overflow-wrap:anywhere]"
          >
            {lastError}
            {maxAttempts > 0 && <span className="block">最多重试 {maxAttempts} 次</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentMessage({
  message,
  autoExpand,
  rollbackDisabled,
  onRollback,
  onCopy,
  searchKeyword,
  alwaysShowActions = false,
}: Props) {
  const hideThinkingDisplay = useSettingsStore(
    (s) => s.settings.hideThinkingDisplay,
  );
  /** 用户手动展开/收起覆盖；null = 跟随 autoExpand。仅在思考进行中有意义。 */
  const [thinkingUserToggle, setThinkingUserToggle] = useMessageViewState<boolean | null>('thinking-expanded', null);
  /** 思考区内滚：用户上翻后暂停跟随，滑回底部附近再恢复。 */
  const {
    ref: thinkingBodyRef,
    onScroll: onThinkingScroll,
    follow: followThinking,
    restart: restartThinkingFollow,
  } = useStickyFollow<HTMLDivElement>(INNER_FOLLOW_THRESHOLD_PX);
  const [copied, setCopied] = useState(false);
  // 思考结束（autoExpand 变 false）时清空手动状态；进行中尊重用户点击
  useEffect(() => {
    if (!autoExpand) {
      setThinkingUserToggle(null);
      restartThinkingFollow();
    }
  }, [autoExpand, restartThinkingFollow, setThinkingUserToggle]);
  const thinkingExpanded = thinkingUserToggle ?? !!autoExpand;

  const handleToggleThinking = () => {
    const next = !thinkingExpanded;
    setThinkingUserToggle(next);
    // 重新展开时恢复跟随底部
    if (next) restartThinkingFollow();
  };

  // 流式思考：用户未上翻时，思考区内滚跟随最新内容（不带动外层对话滚动）。
  // 判定用的是 onThinkingScroll 记下的"用户还在不在底部"，不在这里现量几何 ——
  // 见 useStickyFollow 的说明。
  useIsomorphicLayoutEffect(() => {
    if (!thinkingExpanded || !message.isThinking) return;
    followThinking();
  }, [message.reasoningContent, thinkingExpanded, message.isThinking, followThinking]);

  const handleCopy = () => {
    onCopy?.(message);
    setCopied(true);
    setTimeout(() => setCopied(false), 1300);
  };

  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const isTool = message.role === 'tool';
  // 后台作业的结算告知（自动继续那一轮的 prompt）：系统写的，不是用户打的字。
  const isNotice = message.role === 'notice';
  const userInput = useMemo(
    () => isUser ? validateUserInput(message.content, message.userInput) : undefined,
    [isUser, message.content, message.userInput],
  );
  // 思考只在输出过程中显示（isThinking），回复完成后即消失（完成即删）；
  // 带 tool_calls 的消息 live 时 handleToolCallStart 已清 reasoningContent，
  // 无需单独条件。reasoningContent 字段始终保留供 LLM 回传
  // （DeepSeek thinking 模式要求）。
  const hasReasoning =
    !!message.isThinking && !!message.reasoningContent && !hideThinkingDisplay;

  // Hide empty assistant messages without loading, tool calls, or visible reasoning
  if (
    !isUser &&
    !isSystem &&
    !isTool &&
    !message.isLoading &&
    !message.content &&
    !hasReasoning &&
    !message.toolCall
  ) {
    return null;
  }

  // ─── User message: right-aligned bubble ──
  if (isUser) {
    const sentAt = new Date(message.timestamp).toLocaleString();
    const images = message.imagePaths ?? [];
    // 日常阅读保持附件形态；全文检索时保留原文高亮，命中文件正文也能看见。
    const displayContent = searchKeyword?.trim() ? message.content : userInput?.text ?? message.content;
    return (
      <div className="group flex justify-end my-1">
        <div className="flex min-w-0 max-w-[80%] flex-col items-end">
          {(images.length > 0 || (userInput?.textAttachments.length ?? 0) > 0) && (
            <UserMessageAttachments files={userInput?.textAttachments ?? []} imagePaths={images} mobile={alwaysShowActions} />
          )}
          {!searchKeyword?.trim() && (userInput?.skills?.length ?? 0) > 0 && (
            <div className="mb-1.5 max-w-full">
              <SkillChips skills={userInput!.skills!} mobile={alwaysShowActions} justify="end" />
            </div>
          )}
          {!searchKeyword?.trim() && userInput?.replyTo && (
            <div
              className="mb-1 max-w-full truncate text-meta leading-5 text-fg-tertiary"
              title={userInput.replyTo.question}
            >
              回复：{userInput.replyTo.question}
            </div>
          )}
          {displayContent ? (
            <div className="max-w-full rounded-xl bg-surface-raised px-3 py-2 text-read text-fg whitespace-pre-wrap [overflow-wrap:anywhere]">
              {highlightPlainText(displayContent, searchKeyword)}
            </div>
          ) : null}
          <div
            className={`mt-1 flex w-max max-w-full items-center justify-end gap-2 text-caption text-fg-tertiary transition duration-200 ease-standard focus-within:opacity-100 focus-within:translate-y-0 ${
              alwaysShowActions
                ? 'opacity-100 translate-y-0'
                : 'opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0'
            }`}
          >
            <span className="min-w-0 truncate">{sentAt}</span>
            <div className="flex items-center gap-0.5">
              {onRollback && <button
                type="button"
                onClick={() => onRollback(message)}
                disabled={rollbackDisabled}
                className="p-1 rounded text-fg-tertiary hover:text-amber-300 hover:bg-state-soft disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                title={
                  rollbackDisabled ? '任务运行中，暂不能撤回' : '撤回到这条消息'
                }
              >
                <Undo2 className="w-3.5 h-3.5" strokeWidth={1.5} />
              </button>}
              <button
                type="button"
                onClick={handleCopy}
                className="p-1 rounded text-fg-tertiary hover:text-fg hover:bg-state-soft transition-colors relative"
                title={copied ? '已复制' : '复制消息'}
              >
                <span className="relative block w-3.5 h-3.5">
                  <Copy className={`w-3.5 h-3.5 absolute inset-0 transition duration-120 ${
                      copied ? 'opacity-0 scale-50' : 'opacity-100 scale-100'
                    }`} strokeWidth={1.5} />
                  <Check className={`w-3.5 h-3.5 text-emerald-400 absolute inset-0 transition duration-120 ${
                      copied ? 'opacity-100 scale-100' : 'opacity-0 scale-50'
                    }`} strokeWidth={1.5} />
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── Job notice: system-authored, NOT the user's own words ───
  //
  // 后台作业跑完、这一轮已经结束，系统自动开一轮把结局交给模型，那条 prompt
  // 就是它。渲染成一张工具卡（同一个组件骨架，见 `JobNoticeCard`）：它不是
  // 用户说的话（自动继续的额度只由真的用户输入重置），也不该是一段看着像
  // 谁发的正文 —— 卡片的形态本身就说明「这是系统/模型做的事」。
  if (isNotice) {
    return <JobNoticeCard message={message} searchKeyword={searchKeyword} />;
  }

  // ─── System message ───
  if (isSystem) {
    if (message.isRetrying) {
      return <RetryIndicator message={message} />;
    }
    // 上下文压缩卡片：进行中（防停滞误解）→ 完成（可见摘要）→ 跳过
    if (message.compaction) {
      return <CompactionCard message={message} />;
    }
    return (
      <div className="flex justify-center my-1">
        <div className="text-meta text-fg-tertiary italic px-2 py-1 break-words [overflow-wrap:anywhere]">
          {message.content}
        </div>
      </div>
    );
  }

  // ─── Tool result: rendered via ToolCallCard, skip here ───
  if (isTool) {
    return null;
  }

  // ─── Assistant message ───
  return (
    <div className="flex justify-start my-1">
      <div className="min-w-0 max-w-[90%]">
        {/* Thinking / Reasoning foldable */}
        {hasReasoning && (
          <div className="mb-0.5">
            <button
              type="button"
              onClick={handleToggleThinking}
              className="flex items-center gap-1 text-meta text-fg-tertiary hover:text-fg-secondary transition-colors"
            >
              <ChevronRight className={`w-3 h-3 transition-transform ${thinkingExpanded ? 'rotate-90' : ''}`} strokeWidth={1.5} />
              <span>{message.isThinking ? '思考中' : '已思考'}</span>
              {message.isThinking && (
                <svg
                  className="animate-spin h-3 w-3"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  ></circle>
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  ></path>
                </svg>
              )}
            </button>
            {thinkingExpanded && (
              <div
                ref={thinkingBodyRef}
                onScroll={onThinkingScroll}
                className="mt-1.5 max-h-[40vh] overflow-y-auto overscroll-contain pl-4 border-l-2 border-edge text-meta text-fg-secondary whitespace-pre-wrap break-words"
              >
                {message.reasoningContent}
              </div>
            )}
          </div>
        )}

        {/* Main content */}
        {message.isLoading ? (
          // 等待首字的占位：可见的「任务运行中」由 AgentTranscript 底部常驻的 AgentRunStatus 负责
          <span className="sr-only">任务运行中</span>
        ) : !message.content ? (
          hasReasoning ? null : (
            <div className="text-read text-fg-tertiary italic">（无内容）</div>
          )
        ) : (
          <div className={MARKDOWN_CLASS}>
            <MarkdownBody key={message.id} content={message.content} />
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(AgentMessage);

/**
 * 作业状态 → 卡片色调与展开区里的状态字色。文案由后端给
 * （`build_job_settlement_notice`），**认不出的状态照原样显示、只是不着色**
 * —— 后端将来多一种说法时界面不会变哑巴。
 *
 * 标题行**不放状态胶囊**：正常结束（已完成）就安安静静一张卡，出问题才靠卡片
 * 色调与展开区里的状态字出声 —— 与工具卡只在「被阻止 / 超时」时才标红一致。
 * 色调用的是 {@link ToolCardTone}（同一套壳的色调）。
 */
const JOB_STATUS_STYLE: Record<string, { tone: ToolCardTone; text: string }> = {
  已完成: { tone: 'default', text: 'text-emerald-400' },
  执行失败: { tone: 'danger', text: 'text-red-400' },
  已被终止: { tone: 'warning', text: 'text-amber-400' },
  随应用退出中断: { tone: 'warning', text: 'text-amber-400' },
  仍在运行: { tone: 'default', text: 'text-sky-400' },
};

const UNKNOWN_JOB_STATUS = { tone: 'default' as ToolCardTone, text: 'text-fg-tertiary' };

/**
 * 「系统告知」卡：后台作业的结算告知（`role=notice`）。
 *
 * 长得跟工具调用卡一样（同一个 `ToolCardFrame` 骨架、同一套宽度与展开行为）：
 * 左边「后台作业」胶囊 + `$ 命令` 摘要（与当初那条 bash 卡显示的是同一行），
 * 点开是每个作业一行（含状态）与给模型的指令。它不是用户说的话，所以不用用户
 * 气泡；给模型的那句「用 `job_output` 去读输出」是操作说明而不是结论，**默认
 * 收起** —— 折叠态只留干净的一行。
 */
function JobNoticeCard({
  message,
  searchKeyword,
}: {
  message: AgentMessageType;
  searchKeyword?: string;
}) {
  const { jobs, notes } = parseJobNotice(message.content);
  const head = jobs[0];
  // 摘要行照抄 bash 卡：`$ 命令`。命令按 job_id 从作业 store 取（作业是在这次
  // 运行里派发的就一定在），取不到（应用重启后又过了台账保留期）就回落成告知
  // 文本里的描述 —— 摘要行永远有东西，不会因为查不到作业而空掉。
  const jobCommand = useJobStore((s) => (head ? s.jobs[head.jobId]?.command : undefined));
  const preview = head
    ? jobs.length > 1
      ? `${jobs
          .slice(0, 3)
          .map((j) => j.jobId)
          .join('、')}${jobs.length > 3 ? ` 等 ${jobs.length} 个作业` : ''}`
      : jobCommand
        ? `$ ${jobCommand}`
        : head.description
    : (notes[0] ?? '');
  const bodyNotes = head ? notes : notes.slice(1);
  const notesText = bodyNotes.join('\n');

  // 搜索命中的若是收起区里的字（比如 job_output），直接展开 —— 否则用户只看到
  // 一张高亮的卡片，找不到命中在哪。
  const keyword = searchKeyword?.trim().toLowerCase() ?? '';
  const notesMatched = !!keyword && notesText.toLowerCase().includes(keyword);
  const [expanded, setExpanded] = useMessageViewState('notice-expanded', false);
  useEffect(() => {
    if (notesMatched) setExpanded(true);
  }, [notesMatched, setExpanded]);

  const headTone = head ? (JOB_STATUS_STYLE[head.status] ?? UNKNOWN_JOB_STATUS).tone : 'default';

  return (
    <div className="my-1 flex min-w-0 justify-start">
      {/* 宽度策略与工具卡一致：收起时最多 85%，展开后占满 */}
      <div className={`min-w-0 ${expanded ? 'w-full' : 'max-w-[85%]'}`}>
        <ToolCardFrame
          // 图标借 bash 的终端图标：作业就是后台跑的 shell 命令（toolCatalog
          // 里没有 job_* 的行，默认图标是个齿轮，放在这里认不出是什么）。
          toolName="bash"
          // 认不出格式时连身份一起换：它确实还是一句系统告知，只是不再是一行
          // 作业（那种情况下预览给的是原文第一行）。
          label={head ? '后台作业' : '系统告知'}
          tone={headTone}
          preview={preview}
          expanded={expanded}
          onToggle={() => setExpanded((v) => !v)}
        >
          {expanded && (
            <div className="min-w-0 border-t border-edge/50 px-3 py-1.5">
              <ul className="mb-1 space-y-0.5">
                {jobs.map((job) => {
                  const style = JOB_STATUS_STYLE[job.status] ?? UNKNOWN_JOB_STATUS;
                  return (
                    <li key={job.jobId} className="flex items-baseline gap-2 text-meta">
                      <span className="flex-shrink-0 font-mono text-fg-secondary">{job.jobId}</span>
                      <span
                        className="min-w-0 flex-1 truncate text-fg-secondary"
                        title={job.description}
                      >
                        {job.description}
                      </span>
                      <span className={`flex-shrink-0 ${style.text}`}>{job.status}</span>
                    </li>
                  );
                })}
              </ul>
              {notesText && (
                <div className="whitespace-pre-wrap break-words text-meta text-fg-tertiary [overflow-wrap:anywhere]">
                  {highlightPlainText(notesText, searchKeyword)}
                </div>
              )}
            </div>
          )}
        </ToolCardFrame>
      </div>
    </div>
  );
}

/** 压缩进行中卡片：实时生成的摘要文本是主角，逐字增长即"没卡住"。 */
function CompactionRunningCard({ message }: { message: AgentMessageType }) {
  const comp = message.compaction;
  const live = comp?.summary ?? '';
  const isOverflow = comp?.trigger === 'context-overflow';
  // 仅当用户已在底部附近时跟随滚动；用户上翻看历史时不打扰（判定见 useStickyFollow）
  const {
    ref: previewRef,
    onScroll: onPreviewScroll,
    follow: followPreview,
  } = useStickyFollow<HTMLDivElement>(INNER_FOLLOW_THRESHOLD_PX);
  useIsomorphicLayoutEffect(() => {
    followPreview();
  }, [live, followPreview]);

  return (
    <div className="my-1.5 flex justify-start">
      <div className="min-w-0 max-w-[85%] rounded-md border border-edge/60 bg-surface-raised/50 px-3 py-2.5">
        <div className="flex items-baseline gap-2">
          {/* 静态状态点（不转圈，避免与"思考中"的 spinner 混淆） */}
          <span className="h-2 w-2 shrink-0 translate-y-[-1px] rounded-full bg-violet-400/90 ring-2 ring-violet-400/15" />
          <span className="text-meta font-medium text-fg">
            正在压缩上下文
          </span>
          <span className="truncate text-caption text-fg-tertiary">
            {isOverflow
              ? '上下文超限，压缩早期历史后自动重试'
              : '总结早期历史、释放上下文空间'}
          </span>
        </div>
        {/* 实时进度是主角：生成中的摘要，逐字增长就是"没卡住"的最好证明 */}
        <div
          ref={previewRef}
          onScroll={onPreviewScroll}
          className="mt-2 max-h-44 overflow-y-auto rounded-md border border-edge/40 bg-surface-sunken/60 px-2.5 py-2"
        >
          {live ? (
            <pre className="whitespace-pre-wrap font-mono text-body leading-relaxed text-fg-secondary [overflow-wrap:anywhere]">
              {live}
            </pre>
          ) : (
            <span className="text-meta italic text-fg-tertiary">
              {/* 摘要分两段：模型先写 <analysis> 梳理对话（后端不推那段文本，所以
                  这段时间卡片一直是空的），再写八段正文。文案要同时成立"还没吐
                  第一个字"和"正在梳理"两种情形 */}
              正在梳理对话内容…
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** 上下文压缩卡片：进行中（实时进度）→ 完成（摘要可见）。 */
function CompactionCard({ message }: { message: AgentMessageType }) {
  const comp = message.compaction;
  const [expanded, setExpanded] = useMessageViewState('compaction-expanded', comp?.status === 'done');
  // 完成瞬间默认展开摘要：用户正看着实时文本，别让它在原地"消失"成一行折叠
  const status = comp?.status;
  const previousStatus = useRef(status);
  useEffect(() => {
    if (status === 'done' && previousStatus.current !== status) setExpanded(true);
    previousStatus.current = status;
  }, [status, setExpanded]);
  if (!comp) return null;

  // ── 压缩进行中 ──
  if (comp.status === 'running') {
    return <CompactionRunningCard message={message} />;
  }

  // ── 压缩完成：统计 + 摘要（默认展开）──
  const hasStats =
    comp.shadowedMessages != null && comp.shadowedTokens != null;
  return (
    <div className="my-1.5 flex justify-start">
      <div className="min-w-0 max-w-[85%] rounded-md border border-edge/60 bg-surface-raised/50 px-2 py-1.5 text-meta text-fg-secondary">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="group flex w-full items-center justify-between gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-state-mid/20"
        >
          <span className="flex items-center gap-1.5 text-emerald-300">
            <Check className="h-3.5 w-3.5" strokeWidth={1.5} />
            上下文已压缩
          </span>
          {hasStats && (
            <span className="tabular-nums text-fg-tertiary">
              已整理 {comp.shadowedMessages} 条 · ~{comp.shadowedTokens} tokens
            </span>
          )}
          <ChevronDown className={`h-3 w-3 shrink-0 text-fg-tertiary transition-transform duration-200 group-hover:text-fg-secondary ${expanded ? 'rotate-180' : ''}`} strokeWidth={1.5} />
        </button>
        {expanded && comp.summary && (
          <div className="mt-1.5 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md bg-surface-sunken/60 p-2 font-mono text-meta leading-relaxed text-fg-secondary [overflow-wrap:anywhere]">
            {comp.summary}
          </div>
        )}
      </div>
    </div>
  );
}
