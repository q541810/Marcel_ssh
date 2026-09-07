import { memo, useState, useEffect, useRef, useCallback } from 'react';
import type { AgentMessage } from '@/lib/types';
import FileChangeView from './FileChangeView';
import { useConversationStore } from '@/stores/conversationStore';
import { useSettingsStore } from '@/stores/settingsStore';

interface Props {
  message: AgentMessage;
  autoExpand?: boolean;
  /** Stable id for parent expand tracking (avoids inline closures). */
  messageId?: string;
  onExpandChange?: (messageId: string, expanded: boolean) => void;
}

const TOOL_ICONS: Record<string, JSX.Element> = {
  connection_info: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
    </svg>
  ),
  bash: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  ),
  // 兼容历史消息（旧工具名 execute_command）
  execute_command: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  ),
  read_file: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  ),
  write_file: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
    </svg>
  ),
  list_directory: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
    </svg>
  ),
  search_files: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
    </svg>
  ),
  system_info: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
    </svg>
  ),
  ask_user: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
    </svg>
  ),
  // subagent（派发子agent）工具图标；task 键保留作历史消息兼容
  subagent: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 3v14a2 2 0 002 2h2m0 0a2 2 0 104 0m-4 0a2 2 0 104 0m5-11v2a3 3 0 01-3 3h-3m0 0V7a2 2 0 00-2-2H8m5 4H5a2 2 0 01-2-2V3h4" />
    </svg>
  ),
  task: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 3v14a2 2 0 002 2h2m0 0a2 2 0 104 0m-4 0a2 2 0 104 0m5-11v2a3 3 0 01-3 3h-3m0 0V7a2 2 0 00-2-2H8m5 4H5a2 2 0 01-2-2V3h4" />
    </svg>
  ),
};

const DEFAULT_ICON = (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);

/** Safely extract a string value from a JSON value (handles both direct strings and {value: "..."}) */
function asStr(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.value === 'string') return o.value;
    if (typeof o.text === 'string') return o.text;
  }
  return undefined;
}

function asStrArray(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const arr = v.map((item) => asStr(item)).filter(Boolean) as string[];
    if (arr.length > 0) return arr;
  }
  return undefined;
}

export const PLAN_TOOL_LABELS: Record<string, string> = {
  create_plan: '创建plan',
  update_plan_item: '更新plan步骤',
  edit_plan: '编辑plan',
};

export function isPlanTool(toolName: string): boolean {
  return toolName in PLAN_TOOL_LABELS;
}

/** 子agent派发工具（现名 subagent；兼容旧历史消息的 task）。 */
function isSubagentTool(toolName: string): boolean {
  return toolName === 'subagent' || toolName === 'task';
}

/** Extract a short command preview from tool arguments */
function formatToolName(toolName: string): { display: string; isSkill: boolean } {
  if (toolName.startsWith('skill_')) {
    return { display: `SKILL ${toolName.slice(6)}`, isSkill: true };
  }
  if (isSubagentTool(toolName)) {
    return { display: '子agent', isSkill: false };
  }
  return { display: toolName, isSkill: false };
}

/** 打开 subagent 工具对应的子agent对话（查看完整调研过程）。 */
function openSubConversation(metadata: Record<string, unknown> | undefined) {
  const convId = metadata?.subConversationId;
  if (typeof convId === 'string' && convId) {
    void useConversationStore.getState().switchConversation(convId);
  }
}

export function getCommandPreview(toolName: string, args: Record<string, unknown> | undefined): string {
  if (!args) return '';

  if (toolName.startsWith('skill_')) return '';
  if (toolName === 'bash' || toolName === 'execute_command') {
    const cmd = asStr(args.command);
    if (cmd) {
      const preview = cmd.length > 40 ? cmd.slice(0, 40) + '...' : cmd;
      return `$ ${preview}`;
    }
  }
  if (toolName === 'read_file' || toolName === 'write_file' || toolName === 'edit_file') {
    const path = asStr(args.path);
    if (path) return path;
  }
  if (toolName === 'list_directory') {
    const path = asStr(args.path);
    if (path) return path;
    return '/';
  }
  if (toolName === 'search_files') {
    const pattern = asStr(args.pattern);
    const path = asStr(args.path);
    const preview = `${pattern || ''} ${path || ''}`.trim();
    if (preview) return preview;
  }
  if (toolName === 'web_search') {
    const query = asStr(args.query);
    if (query) return query;
  }
  if (toolName === 'ask_user') {
    const questions = args.questions;
    if (Array.isArray(questions) && questions.length > 0) {
      const firstQ = questions[0] as Record<string, unknown> | undefined;
      const header = asStr(firstQ?.header) ?? asStr(firstQ?.question);
      const preview = header ? (header.length > 40 ? header.slice(0, 40) + '...' : header) : '';
      const count = questions.length > 1 ? ` +${questions.length - 1} 题` : '';
      return `? ${preview}${count}`;
    }
  }
  if (toolName === 'http_get') {
    const url = asStr(args.url);
    if (url) return url;
    const urls = asStrArray(args.urls);
    if (urls) {
      if (urls.length === 1) return urls[0];
      const first = urls[0].length > 40 ? urls[0].slice(0, 40) + '...' : urls[0];
      return `${first} +${urls.length - 1} more`;
    }
  }
  if (isSubagentTool(toolName)) {
    const description = asStr(args.description);
    const prompt = asStr(args.prompt);
    const preview = description || prompt || '';
    return preview.length > 40 ? preview.slice(0, 40) + '...' : preview;
  }
  return '';
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
    const { display: displayName, isSkill } = formatToolName(tr.toolName);
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
            <span>{PLAN_TOOL_LABELS[tr.toolName]}</span>
          </div>
        </div>
      );
    }
    const icon = TOOL_ICONS[tr.toolName] ?? DEFAULT_ICON;
    const preview = getCommandPreview(tr.toolName, tr.arguments);
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
    const argHost = asStr((tr.arguments as Record<string, unknown> | undefined)?.host) ?? '';
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
                {icon}
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
          tr.success && (tr.toolName === 'write_file' || tr.toolName === 'edit_file') ? (
            <FileChangeView toolName={tr.toolName} arguments={tr.arguments || {}} metadata={tr.metadata} />
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
    const { display: displayName, isSkill } = formatToolName(tc.name);
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
            <span>{PLAN_TOOL_LABELS[tc.name]}</span>
          </div>
        </div>
      );
    }
    const icon = TOOL_ICONS[tc.name] ?? DEFAULT_ICON;
    const preview = getCommandPreview(tc.name, tc.arguments);
    const timeoutSecs = tc.name === 'bash' || tc.name === 'execute_command' ? commandTimeoutSecs : 0;
    // 多机操控：发起瞬间即显示目标机器（参数 host）。此分支无结果 metadata，
    // 只能从参数读；真正执行/完成后由 toolResult 分支的权威 label 接管。
    const tcHost = asStr((tc.arguments as Record<string, unknown> | undefined)?.host) ?? '';
    // 按码点截断（机器名可能含中文/emoji）；tooltip 给全名。
    const tcHostChars = Array.from(tcHost);
    const tcDisplayHost =
      tcHostChars.length > 12 ? `${tcHostChars.slice(0, 12).join('')}…` : tcHost;

    return (
      <div className="rounded-md border border-zinc-700/60 bg-zinc-800/50">
        <div className="flex items-center justify-between px-3 py-1.5">
          <div className="flex items-center gap-2 min-w-0">
            <span className="flex items-center gap-1.5 flex-shrink-0 text-xs font-mono px-1.5 py-0.5 rounded-lg bg-zinc-700/80 text-zinc-300">
              {icon}
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
