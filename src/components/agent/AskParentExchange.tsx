import { memo, useState } from 'react';
import { ChevronDown, CircleHelp, Reply } from 'lucide-react';
import type { ToolViewProps } from './toolViews';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * 子对话里的 `ask_parent`（注册在 toolViews）：不画成工具卡，而是一问一答两个对话气泡
 * ——「问主 Agent：…」（背景信息默认收起）和「主 Agent 回答：…」。回答还没来时，问句下面
 * 是一行淡色的「等待主 Agent 回答…」。参数还在撰写（问题没写完）时不占位。
 *
 * 子对话是只读的旁观视角：提问方（子 agent）在左，回答方（主 agent）在右，和主对话里
 * 时间线卡的气泡同一套语言。
 */
function AskParentExchange({ message, grouped }: ToolViewProps) {
  const tr = message.toolResult;
  const [showContext, setShowContext] = useState(false);
  if (!tr || message.isComposing) return null;
  const question = str(tr.arguments?.question).trim();
  const context = str(tr.arguments?.context).trim();
  const waiting = !!message.isExecuting;
  const answer = waiting ? '' : tr.result.trim();
  const failed = !waiting && tr.success === false;

  return (
    <div className={`min-w-0 space-y-1.5 py-0.5 ${grouped ? 'pl-3' : ''}`} data-testid="ask-parent">
      <div className="flex min-w-0 justify-start">
        <div className="min-w-0 max-w-[88%] rounded-2xl rounded-tl-md border border-sky-500/25 bg-sky-500/10 px-3 py-2">
          <div className="mb-0.5 flex items-center gap-1.5 text-[11px] font-medium text-sky-300">
            <CircleHelp className="h-3 w-3" aria-hidden="true" />
            问主 Agent
          </div>
          <p className="whitespace-pre-wrap break-words text-[13px] leading-5 text-zinc-100 [overflow-wrap:anywhere]">
            {question || '（问题内容缺失）'}
          </p>
          {context && (
            <>
              <button
                type="button"
                aria-expanded={showContext}
                onClick={() => setShowContext((v) => !v)}
                className="mt-1 flex items-center gap-1 text-[12px] text-zinc-400 transition-colors hover:text-zinc-200 [@media(pointer:coarse)]:min-h-8"
              >
                <ChevronDown className={`h-3 w-3 transition-transform ${showContext ? 'rotate-180' : ''}`} aria-hidden="true" />
                背景信息
              </button>
              {showContext && (
                <p className="whitespace-pre-wrap break-words text-[12px] leading-5 text-zinc-400 [overflow-wrap:anywhere]">{context}</p>
              )}
            </>
          )}
        </div>
      </div>
      {waiting ? (
        <div className="px-1 text-[12px] text-zinc-500" data-testid="ask-parent-waiting">等待主 Agent 回答…</div>
      ) : answer ? (
        <div className="flex min-w-0 justify-end">
          <div
            className={`min-w-0 max-w-[88%] rounded-2xl rounded-tr-md border px-3 py-2 ${
              failed ? 'border-amber-500/25 bg-amber-500/10' : 'border-indigo-500/25 bg-indigo-500/10'
            }`}
          >
            <div className={`mb-0.5 flex items-center gap-1.5 text-[11px] font-medium ${failed ? 'text-amber-300' : 'text-indigo-300'}`}>
              <Reply className="h-3 w-3" aria-hidden="true" />
              {failed ? '主 Agent 没有回答' : '主 Agent 回答'}
            </div>
            <p className="whitespace-pre-wrap break-words text-[13px] leading-5 text-zinc-100 [overflow-wrap:anywhere]">{answer}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default memo(AskParentExchange) as (props: ToolViewProps) => JSX.Element | null;
