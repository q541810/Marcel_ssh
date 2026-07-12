import { memo, useState, useEffect, useRef } from 'react';
import type { AgentMessage } from '@/lib/types';
import FileChangeView from './FileChangeView';

interface Props {
  message: AgentMessage;
  autoExpand?: boolean;
  onExpandChange?: (expanded: boolean) => void;
}

const TOOL_ICONS: Record<string, JSX.Element> = {
  connection_info: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
    </svg>
  ),
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

const PLAN_TOOL_LABELS: Record<string, string> = {
  create_plan: '创建plan',
  update_plan_item: '更新plan步骤',
  edit_plan: '编辑plan',
};

function isPlanTool(toolName: string): boolean {
  return toolName in PLAN_TOOL_LABELS;
}

/** Extract a short command preview from tool arguments */
function formatToolName(toolName: string): { display: string; isSkill: boolean } {
  if (toolName.startsWith('skill_')) {
    return { display: `SKILL ${toolName.slice(6)}`, isSkill: true };
  }
  return { display: toolName, isSkill: false };
}

export function getCommandPreview(toolName: string, args: Record<string, unknown> | undefined): string {
  if (!args) return '';

  if (toolName.startsWith('skill_')) return '';
  if (toolName === 'execute_command') {
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
  return '';
}

function ToolCallCard({ message, autoExpand, onExpandChange }: Props) {
  const [expanded, setExpanded] = useState(autoExpand ?? false);
  const wasExecutingRef = useRef(message.isExecuting);
  const outputRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    onExpandChange?.(expanded);
  }, [expanded, onExpandChange]);

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

    return (
      <div className={`rounded-md border ${tr.blocked ? 'border-red-800/60 bg-red-950/30' : (tr.wasTimeout || tr.wasAborted) ? 'border-amber-700/60 bg-amber-950/20' : 'border-zinc-700/60 bg-zinc-800/50'}`}>
        <button
          onClick={() => !isExecuting && setExpanded((v) => !v)}
          className="group w-full text-left"
        >
          <div className="flex items-center justify-between px-3 py-1.5">
            <div className="flex items-center gap-2 min-w-0">
              <span className="flex items-center gap-1.5 flex-shrink-0 text-xs font-mono px-1.5 py-0.5 rounded-lg bg-zinc-700/80 text-zinc-300">
                {icon}
                <span>{displayName}</span>
              </span>
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
        </button>
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
          <div className={`border-t border-zinc-700/50 px-3 py-1.5 ${isExecuting ? '' : 'hidden'}`}>
            <pre ref={outputRef} className="text-xs text-zinc-400 whitespace-pre-wrap break-words max-h-[120px] overflow-y-auto font-mono leading-relaxed">
              {tr.result || ''}
            </pre>
          </div>
        )}
        {expanded && !isExecuting && (
          (tr.toolName === 'write_file' || tr.toolName === 'edit_file') ? (
            <FileChangeView toolName={tr.toolName} arguments={tr.arguments || {}} metadata={tr.metadata} />
          ) : (
            <div className="border-t border-zinc-700/50 px-3 py-1.5">
              <pre className="text-xs text-zinc-400 whitespace-pre-wrap break-words max-h-64 overflow-y-auto font-mono leading-relaxed">
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
    const timeoutSecs = tc.name === 'execute_command'
      ? (typeof tc.arguments?.timeout_secs === 'number' ? tc.arguments.timeout_secs as number : 120)
      : 0;

    return (
      <div className="rounded-md border border-zinc-700/60 bg-zinc-800/50">
        <div className="flex items-center justify-between px-3 py-1.5">
          <div className="flex items-center gap-2 min-w-0">
            <span className="flex items-center gap-1.5 flex-shrink-0 text-xs font-mono px-1.5 py-0.5 rounded-lg bg-zinc-700/80 text-zinc-300">
              {icon}
              <span>{displayName}</span>
            </span>
            {preview && (
              <span className="text-sm text-zinc-400 truncate font-mono">{preview}</span>
            )}
            {timeoutSecs > 60 && (
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
