import { useState } from 'react';
import type { AgentMessage } from '@/lib/types';

interface Props {
  message: AgentMessage;
}

const TOOL_ICONS: Record<string, JSX.Element> = {
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
    web_search: (
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10a1 1 0 11-2 0 1 1 0 012 0z" />
        </svg>
    ),
    http_get: (
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
        </svg>
    ),
    system_info: (
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
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

/** Extract a short command preview from tool arguments */
function getCommandPreview(toolName: string, args: Record<string, unknown> | undefined): string {
    if (!args) return '';

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
        // 首先尝试单个 query 参数
        const query = asStr(args.query);
        if (query) {
            return query.length > 40 ? query.slice(0, 40) + '...' : query;
        }
        // 然后尝试 queries 数组参数
        const queries = args.queries;
        if (Array.isArray(queries) && queries.length > 0) {
            // 处理数组元素可能是字符串或对象的情况
            const firstQuery = queries[0];
            const firstQueryStr = asStr(firstQuery);
            if (firstQueryStr) {
                if (queries.length === 1) {
                    return firstQueryStr.length > 40 ? firstQueryStr.slice(0, 40) + '...' : firstQueryStr;
                } else {
                    return `${firstQueryStr.length > 30 ? firstQueryStr.slice(0, 30) + '...' : firstQueryStr} + ${queries.length - 1} 个查询`;
                }
            }
        }
    }
    if (toolName === 'http_get') {
        // 首先尝试单个 url 参数
        const url = asStr(args.url);
        if (url) {
            return url.length > 40 ? url.slice(0, 40) + '...' : url;
        }
        // 然后尝试 urls 数组参数
        const urls = args.urls;
        if (Array.isArray(urls) && urls.length > 0) {
            const firstUrl = urls[0];
            const firstUrlStr = asStr(firstUrl);
            if (firstUrlStr) {
                if (urls.length === 1) {
                    return firstUrlStr.length > 40 ? firstUrlStr.slice(0, 40) + '...' : firstUrlStr;
                } else {
                    return `${firstUrlStr.length > 30 ? firstUrlStr.slice(0, 30) + '...' : firstUrlStr} + ${urls.length - 1} 个 URL`;
                }
            }
        }
    }
    return '';
}

export default function ToolCallCard({ message }: Props) {
  const [expanded, setExpanded] = useState(false);

  // Handle tool result messages (from stored history or live stream)
  if (message.toolResult) {
    const tr = message.toolResult;
    const icon = TOOL_ICONS[tr.toolName] ?? DEFAULT_ICON;
    const preview = getCommandPreview(tr.toolName, tr.arguments);

    return (
      <div className={`rounded-lg border ${tr.blocked ? 'border-red-800/60 bg-red-950/30' : 'border-zinc-700/60 bg-zinc-800/50'}`}>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="group w-full text-left"
        >
          <div className="flex items-center justify-between px-3 py-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="flex items-center gap-1.5 flex-shrink-0 text-xs font-mono px-1.5 py-0.5 rounded-lg bg-zinc-700/80 text-zinc-300">
                {icon}
                <span>{tr.toolName}</span>
              </span>
              {preview && (
                <span className="text-sm text-zinc-400 truncate font-mono">{preview}</span>
              )}
              {tr.blocked && (
                <span className="flex-shrink-0 text-xs text-red-400 font-medium">已阻止</span>
              )}
            </div>
            <svg
              className={`w-4 h-4 flex-shrink-0 text-zinc-500 group-hover:text-zinc-300 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </button>
        {expanded && tr.result && (
          <div className="border-t border-zinc-700/50 px-3 py-2">
            <pre className="text-xs text-zinc-400 whitespace-pre-wrap break-words max-h-64 overflow-y-auto font-mono leading-relaxed">
              {tr.result}
            </pre>
          </div>
        )}
      </div>
    );
  }

  // Handle assistant messages with toolCall (live streaming tool call info)
  if (message.toolCall) {
    const tc = message.toolCall;
    const icon = TOOL_ICONS[tc.name] ?? DEFAULT_ICON;
    const preview = getCommandPreview(tc.name, tc.arguments);

    return (
      <div className="rounded-lg border border-zinc-700/60 bg-zinc-800/50">
        <div className="flex items-center justify-between px-3 py-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="flex items-center gap-1.5 flex-shrink-0 text-xs font-mono px-1.5 py-0.5 rounded-lg bg-zinc-700/80 text-zinc-300">
              {icon}
              <span>{tc.name}</span>
            </span>
            {preview && (
              <span className="text-sm text-zinc-400 truncate font-mono">{preview}</span>
            )}
          </div>
        </div>
      </div>
    );
  }

  return null;
}
