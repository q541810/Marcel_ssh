import { memo, useState, useEffect, useRef, useCallback } from 'react';
import type { AgentMessage } from '@/lib/types';
import FileChangeView from './FileChangeView';
import { useConversationStore } from '@/stores/conversationStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { readWebToolStatus, webToolChips, webToolNotice } from '@/lib/webToolStatus';
import type { ChipTone } from '@/lib/webToolStatus';
import {
  asArgString,
  fileChangeToolName,
  isPlanTool,
  isSubagentTool,
  toolDisplayName,
  toolIconPaths,
  toolLabel,
  toolPreview,
  toolSpec,
} from '@/lib/toolCatalog';

/** 状态小标记的配色：中性=后端标识，warning=降级/被网站拦截。 */
const CHIP_TONE_CLASS: Record<ChipTone, string> = {
  neutral: 'bg-zinc-600/60 text-zinc-200',
  warning: 'bg-amber-500/10 text-amber-300',
  danger: 'bg-red-500/10 text-red-300',
};

interface Props {
  message: AgentMessage;
  autoExpand?: boolean;
  /** Stable id for parent expand tracking (avoids inline closures). */
  messageId?: string;
  onExpandChange?: (messageId: string, expanded: boolean) => void;
}

/**
 * 工具标题图标。路径表在 `@/lib/toolCatalog`（一个工具一行），这里只负责用
 * 统一的描边 svg 包起来 —— 13 个图标原本各抄一遍 `<svg className="w-3.5 h-3.5"
 * fill="none" stroke="currentColor" viewBox="0 0 24 24">`，改尺寸要改 13 处。
 */
function ToolIcon({ toolName }: { toolName: string }) {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      {toolIconPaths(toolName).map((d, i) => (
        <path key={i} strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={d} />
      ))}
    </svg>
  );
}

/** 打开 subagent 工具对应的子agent对话（查看完整调研过程）。 */
function openSubConversation(metadata: Record<string, unknown> | undefined) {
  const convId = metadata?.subConversationId;
  if (typeof convId === 'string' && convId) {
    void useConversationStore.getState().switchConversation(convId);
  }
}

function ToolCallCard({ message, autoExpand, messageId, onExpandChange }: Props) {
  const [expanded, setExpanded] = useState(autoExpand ?? false);
  const wasExecutingRef = useRef(message.isExecuting);
  const outputRef = useRef<HTMLPreElement>(null);
  const onExpandChangeRef = useRef(onExpandChange);
  const lastNotifiedExpandedRef = useRef<boolean | null>(null);
  const expandNotifyId = messageId ?? message.id;
  // 真实命令超时来自用户设置（后端 command_timeout_secs），不是模型传参。
  const commandTimeoutSecs = useSettingsStore((s) => s.settings.commandTimeoutSecs);
  // 多机操控：可操作机器集合大小（勾选的服务器数量）。目标机器指示器的
  // 名字截断上限随集合增大而收紧——服务器越多，单条指示器占的宽度预算越小，
  // 避免名字/徽标把卡片标题行顶满。
  const multiHostCount = useSettingsStore(
    (s) => s.settings.experimentalSettings?.multiHostConnectionIds?.length ?? 0,
  );
  // 卡片实际宽度（ResizeObserver 观察卡片根容器）：Agent 面板可拖拽，面板窄
  // → 卡片窄 → 目标机器指示器截断上限进一步收紧，避免在窄面板里顶掉标题行。
  // 用 callback ref 而非 useContainerWidth——ToolCallCard 的 toolResult 分支
  // 是条件渲染，静态 ref 首次为空时 observer 不会建立。
  // React 18 语义：callback ref 返回 cleanup 不生效；卸载时 React 以 null 再调
  // 一次 callback ref，故在 null 分支 disconnect（React 19 兼容同样成立）。
  const [cardWidth, setCardWidth] = useState(0);
  const cardObserverRef = useRef<ResizeObserver | null>(null);
  const cardRefCb = useCallback((node: HTMLDivElement | null) => {
    if (!node) {
      cardObserverRef.current?.disconnect();
      cardObserverRef.current = null;
      return;
    }
    const update = () => setCardWidth(node.clientWidth);
    update();
    cardObserverRef.current?.disconnect();
    const ro = new ResizeObserver(update);
    cardObserverRef.current = ro;
    ro.observe(node);
  }, []);

  onExpandChangeRef.current = onExpandChange;

  // Notify parent only when expanded actually changes (not on every parent re-render).
  useEffect(() => {
    if (lastNotifiedExpandedRef.current === expanded) return;
    lastNotifiedExpandedRef.current = expanded;
    onExpandChangeRef.current?.(expandNotifyId, expanded);
  }, [expanded, expandNotifyId]);

  // Auto-scroll output when at bottom
  useEffect(() => {
    const el = outputRef.current;
    if (!el || !message.isExecuting) return;
    const threshold = 8;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    if (atBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [message.toolResult?.result, message.isExecuting]);

  useEffect(() => {
    if (!autoExpand) {
      setExpanded(false);
    }
  }, [autoExpand]);

  // Auto-collapse when execution completes (transition true→false)
  useEffect(() => {
    const was = wasExecutingRef.current;
    wasExecutingRef.current = message.isExecuting;
    if (was && !message.isExecuting) {
      setExpanded(false);
    }
  }, [message.isExecuting]);

  // Handle tool result messages (from stored history or live stream)
  if (message.toolResult) {
    const tr = message.toolResult;
    const { display: displayName, isSkill } = toolDisplayName(tr.toolName);
    // Skill tools render as thinking-style text, not as cards
    if (isSkill) {
      return (
        <div className="flex justify-start my-1">
          <div className="flex items-center gap-1 text-xs text-zinc-500">
            <span>{tr.summary || displayName}</span>
          </div>
        </div>
      );
    }
    // Plan tools render as lightweight status text (plan state shown in PlanList)
    if (isPlanTool(tr.toolName)) {
      return (
        <div className="flex justify-start my-1">
          <div className="flex items-center gap-1 text-xs text-zinc-500">
            <span>{toolLabel(tr.toolName)}</span>
          </div>
        </div>
      );
    }
    const preview = toolPreview(tr.toolName, tr.arguments);
    // 参数主体是文件改动的工具展开后渲染 diff；不认识的工具回退原始输出。
    const fileChangeTool = fileChangeToolName(tr.toolName);
    const isExecuting = message.isExecuting;
    const hasOutput = !!tr.result;
    const showOutput = (isExecuting && hasOutput) || expanded;
    // 多机操控：目标机器归属。优先用结果 metadata 的权威 targetHostLabel
    // （后端解析 host→会话后回填，含消歧后缀）；执行中 metadata 尚未回填，
    // 从工具调用参数 `host` 读取——发起调用时模型已带上目标机器，执行中
    // 卡片即显示将/正在运行在哪台机器（并发派发多机 subagent 时可区分）。
    const metaHost =
      tr.metadata && typeof (tr.metadata as Record<string, unknown>).targetHostLabel === 'string'
        ? ((tr.metadata as Record<string, unknown>).targetHostLabel as string)
        : '';
    // host 参数仅对支持多机目标的工具（bash/execute_command/upload_file/
    // download_file/subagent/task）有意义；其他工具即使误传也忽略。
    const argHost =
      asArgString((tr.arguments as Record<string, unknown> | undefined)?.host) ?? '';
    const targetHost = metaHost || argHost;
    // 截断上限 = min(绝对上限 10, 机器集合因子, 卡片宽度因子)，且不低于下限。
    // - 集合因子：勾选服务器越多越收紧（120/count：5 台=24 但被 10 封顶，
    //   13 台=9、15+ 台=8）——服务器多时单条指示器宽度预算小；
    // - 宽度因子：Agent 面板可拖拽，卡片窄时进一步收紧（cardWidth/60：
    //   600px=10、360px=6、240px=4）——窄面板里不能顶掉标题行；
    // - 下限 4：极窄也保留可辨识前缀（hover 有全名）。
    const MAX_HOST_CHARS_BASE = 10;
    const MIN_HOST_CHARS = 4;
    // cardWidth===0 表示尚未测量（首次渲染 RO 未回调）：宽度因子不限制，
    // 避免首帧按 0 宽过度收紧后闪跳回正常长度。
    const widthFactor =
      cardWidth > 0 ? Math.floor(cardWidth / 60) : MAX_HOST_CHARS_BASE;
    const collectionFactor = multiHostCount > 0 ? Math.floor(120 / multiHostCount) : MAX_HOST_CHARS_BASE;
    const hostCharLimit = Math.max(
      MIN_HOST_CHARS,
      Math.min(MAX_HOST_CHARS_BASE, widthFactor, collectionFactor),
    );
    // 按码点截断（机器名可能含中文/emoji——slice 会切坏代理对）。
    const hostChars = Array.from(targetHost);
    const displayHost =
      hostChars.length > hostCharLimit
        ? `${hostChars.slice(0, hostCharLimit).join('')}…`
        : targetHost;
    // 子 agent 读写模式标注（subagent metadata.mode === "agent"）
    const subMode =
      isSubagentTool(tr.toolName) && tr.metadata &&
      (tr.metadata as Record<string, unknown>).mode === 'agent'
        ? '读写'
        : '';
    // 联网工具（web_search / http_get）：本次用的是哪个后端、有没有降级、页面
    // 是否被网站的人机验证拦下。旧会话没有这些字段 → status 为 null，界面不变。
    const webStatus = readWebToolStatus(tr.toolName, tr.metadata);
    const webChips = webStatus ? webToolChips(webStatus) : [];
    const webNotice = webStatus ? webToolNotice(webStatus) : null;

    return (
      <div
        ref={cardRefCb}
        className={`min-w-0 max-w-full rounded-md border ${tr.blocked ? 'border-red-800/60 bg-red-950/30' : (tr.wasTimeout || tr.wasAborted) ? 'border-amber-700/60 bg-amber-950/20' : 'border-zinc-700/60 bg-zinc-800/50'}`}
      >
        <button
          onClick={() => !isExecuting && setExpanded((v) => !v)}
          className="group w-full min-w-0 text-left"
        >
          <div className="flex items-center justify-between px-3 py-1.5 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="flex items-center gap-1.5 flex-shrink-0 text-xs font-mono px-1.5 py-0.5 rounded-lg bg-zinc-700/80 text-zinc-300">
                <ToolIcon toolName={tr.toolName} />
                <span>{displayName}</span>
              </span>
              {targetHost && (
                <span
                  className="flex-shrink-0 text-[11px] px-1.5 py-0.5 rounded-md bg-zinc-600/60 text-zinc-200 font-medium flex items-center gap-1 max-w-[160px]"
                  title={`目标机器：${targetHost}`}
                >
                  <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" />
                  </svg>
                  <span className="truncate">{displayHost}</span>
                </span>
              )}
              {subMode && (
                <span className="flex-shrink-0 text-[11px] px-1.5 py-0.5 rounded-md bg-zinc-600/60 text-zinc-200 font-medium">
                  读写子agent
                </span>
              )}
              {webChips.map((chip) => (
                <span
                  key={chip.key}
                  className={`flex-shrink-0 text-[11px] px-1.5 py-0.5 rounded-md font-medium ${CHIP_TONE_CLASS[chip.tone]}`}
                  title={chip.title}
                >
                  {chip.label}
                </span>
              ))}
              {preview && (
                <span className="text-sm text-zinc-400 truncate font-mono">{preview}</span>
              )}
              {tr.blocked && (
                <span className="flex-shrink-0 text-xs text-red-400 font-medium">已阻止</span>
              )}
              {!tr.blocked && tr.wasAborted && (
                <span className="flex-shrink-0 text-xs text-amber-400 font-medium">已中断</span>
              )}
              {!tr.blocked && !tr.wasAborted && tr.wasTimeout && (
                <span className="flex-shrink-0 text-xs text-amber-400 font-medium">超时</span>
              )}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {isExecuting ? (
                <svg className="animate-spin h-4 w-4 flex-shrink-0 text-zinc-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
              ) : (
                <svg
                  className={`w-4 h-4 flex-shrink-0 text-zinc-500 group-hover:text-zinc-300 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              )}
            </div>
          </div>
        </button>
        {/* 运行中的 subagent 卡片：提供"查看"入口跳转子对话（实时调研过程） */}
        {isSubagentTool(tr.toolName) && isExecuting && (
          (() => {
            const meta = tr.metadata as Record<string, unknown> | undefined;
            const subConvId = meta?.subConversationId;
            if (typeof subConvId !== 'string' || !subConvId) return null;
            return (
              <button
                type="button"
                onClick={() => openSubConversation(meta)}
                className="group/task w-full border-t border-zinc-700/50 px-3 py-1.5 text-left transition-colors"
              >
                <span className="flex items-center gap-1.5 text-xs font-medium text-sky-400 group-hover/task:text-sky-300">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                  查看实时调研过程 →
                </span>
              </button>
            );
          })()
        )}
        {/* Model approval phase — distinct from execution progress */}
        {message.modelApproval?.status === 'checking' && (
          <div className="border-t border-zinc-700/50 px-3 py-1.5">
            <div className="flex items-center gap-2 text-xs text-indigo-400">
              <svg className="animate-spin h-3 w-3 flex-shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <span>模型审批中…</span>
            </div>
          </div>
        )}
        {message.modelApproval?.status === 'done' && message.modelApproval.decision === 'route_to_human' && (
          <div className="border-t border-zinc-700/50 px-3 py-1.5">
            <div className="text-xs text-amber-400 font-medium mb-0.5">模型建议人工审批</div>
            {message.modelApproval.reasons && message.modelApproval.reasons.length > 0 && (
              <ul className="text-xs text-amber-300/80 space-y-0.5 list-disc list-inside">
                {message.modelApproval.reasons.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            )}
          </div>
        )}
        {message.modelApproval?.status === 'done' && message.modelApproval.decision === 'block' && (
          <div className="border-t border-zinc-700/50 px-3 py-1.5">
            <div className="text-xs text-red-400 font-medium mb-0.5">模型阻止</div>
            {message.modelApproval.reasons && message.modelApproval.reasons.length > 0 && (
              <ul className="text-xs text-red-300/80 space-y-0.5 list-disc list-inside">
                {message.modelApproval.reasons.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            )}
          </div>
        )}
        {/* 联网工具的异常说明：降级 / 被网站拦截 / 无正文。
            放在正文之前，先解释「发生了什么」再看内容，避免用户把验证页正文
            当成真实页面。正常情况不渲染，不占版面。 */}
        {webNotice && !isExecuting && (
          <div className="border-t border-zinc-700/50 px-3 py-2">
            <div
              className={`rounded-lg border px-3 py-2 ${
                webNotice.tone === 'danger'
                  ? 'border-red-700/60 bg-red-950/40'
                  : 'border-amber-700/60 bg-amber-950/40'
              }`}
            >
              <div
                className={`text-xs font-medium mb-0.5 ${
                  webNotice.tone === 'danger' ? 'text-red-300' : 'text-amber-300'
                }`}
              >
                {webNotice.title}
              </div>
              <ul
                className={`text-xs space-y-0.5 list-disc list-inside ${
                  webNotice.tone === 'danger' ? 'text-red-200/90' : 'text-amber-200/90'
                }`}
              >
                {webNotice.lines.map((line, i) => (
                  <li key={i} className="break-all">{line}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
        {showOutput && (
          <div className={`min-w-0 border-t border-zinc-700/50 px-3 py-1.5 ${isExecuting ? '' : 'hidden'}`}>
            <pre
              ref={outputRef}
              className="text-xs text-zinc-400 whitespace-pre max-h-[120px] max-w-full overflow-x-auto overflow-y-auto font-mono leading-relaxed"
            >
              {tr.result || ''}
            </pre>
          </div>
        )}
        {expanded && !isExecuting && (
          tr.success && fileChangeTool ? (
            <FileChangeView toolName={fileChangeTool} arguments={tr.arguments || {}} metadata={tr.metadata} />
          ) : (
            <div className="min-w-0 border-t border-zinc-700/50 px-3 py-1.5">
              {isSubagentTool(tr.toolName) && tr.success && (
                <button
                  onClick={() => openSubConversation(tr.metadata)}
                  className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-sky-400 hover:text-sky-300 transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                  查看完整调研过程 →
                </button>
              )}
              <pre className="text-xs text-zinc-400 whitespace-pre max-h-64 max-w-full overflow-x-auto overflow-y-auto font-mono leading-relaxed">
                {tr.result || 'no output'}
              </pre>
            </div>
          )
        )}
      </div>
    );
  }

  // Handle assistant messages with toolCall (live streaming tool call info)
  if (message.toolCall) {
    const tc = message.toolCall;
    const { display: displayName, isSkill } = toolDisplayName(tc.name);
    // Skill tools render as thinking-style text, not as cards
    if (isSkill) {
      return (
        <div className="flex justify-start my-1">
          <div className="flex items-center gap-1 text-xs text-zinc-500">
            <span>{displayName}</span>
          </div>
        </div>
      );
    }
    // Plan tools render as lightweight status text
    if (isPlanTool(tc.name)) {
      return (
        <div className="flex justify-start my-1">
          <div className="flex items-center gap-1 text-xs text-zinc-500">
            <span>{toolLabel(tc.name)}</span>
          </div>
        </div>
      );
    }
    const preview = toolPreview(tc.name, tc.arguments);
    const timeoutSecs = toolSpec(tc.name)?.payload === 'command' ? commandTimeoutSecs : 0;
    // 多机操控：发起瞬间即显示目标机器（参数 host）。此分支无结果 metadata，
    // 只能从参数读；真正执行/完成后由 toolResult 分支的权威 label 接管。
    const tcHost =
      asArgString((tc.arguments as Record<string, unknown> | undefined)?.host) ?? '';
    // 按码点截断（机器名可能含中文/emoji）；tooltip 给全名。
    const tcHostChars = Array.from(tcHost);
    const tcDisplayHost =
      tcHostChars.length > 12 ? `${tcHostChars.slice(0, 12).join('')}…` : tcHost;

    return (
      <div className="rounded-md border border-zinc-700/60 bg-zinc-800/50">
        <div className="flex items-center justify-between px-3 py-1.5">
          <div className="flex items-center gap-2 min-w-0">
            <span className="flex items-center gap-1.5 flex-shrink-0 text-xs font-mono px-1.5 py-0.5 rounded-lg bg-zinc-700/80 text-zinc-300">
              <ToolIcon toolName={tc.name} />
              <span>{displayName}</span>
            </span>
            {tcHost && (
              <span
                className="flex-shrink-0 text-[11px] px-1.5 py-0.5 rounded-md bg-zinc-600/60 text-zinc-200 font-medium flex items-center gap-1 max-w-[160px]"
                title={`目标机器：${tcHost}`}
              >
                <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" />
                </svg>
                <span className="truncate">{tcDisplayHost}</span>
              </span>
            )}
            {preview && (
              <span className="text-sm text-zinc-400 truncate font-mono">{preview}</span>
            )}
            {timeoutSecs > 0 && (
              <span className="flex items-center gap-1 flex-shrink-0 text-xs text-amber-400">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {timeoutSecs}s
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }

  return null;
}

export default memo(ToolCallCard);
