import { memo } from 'react';
import { toolDisplayName } from '@/lib/toolCatalog';
import { ToolCardFrame } from './toolCardChrome';
import { useMessageViewState } from './messageViewState';
import type { ToolViewProps } from './toolViews';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * 子对话里的 `ask_parent`（注册在 toolViews）：和普通工具调用一样是一行可展开的记录
 * （图标 · 「问主 Agent」· 问题摘要），中性灰，不抢眼。等主 Agent 回答时和别的运行中工具
 * 一样转圈（子对话底部另有一条细条交代「正在等待主 Agent 回答」，并能回到主对话）；
 * 展开后是缩进的纯文字「问：… 答：…」，背景信息再收一层。参数还在撰写（问题没写完）时
 * 不占位。
 *
 * 子对话是只读的旁观视角，所以没有任何输入或按钮——只有这一行记录。
 */
function AskParentExchange({ message, grouped }: ToolViewProps) {
  const tr = message.toolResult;
  const [expanded, setExpanded] = useMessageViewState('ask-parent-expanded', false);
  const [showContext, setShowContext] = useMessageViewState('ask-parent-context', false);
  if (!tr || message.isComposing) return null;
  const question = str(tr.arguments?.question).trim();
  const context = str(tr.arguments?.context).trim();
  const waiting = !!message.isExecuting;
  const answer = waiting ? '' : tr.result.trim();
  const failed = !waiting && tr.success === false;
  const { display } = toolDisplayName(tr.toolName);

  return (
    <div className={`min-w-0 ${grouped ? 'pl-3' : ''}`} data-testid="ask-parent">
      <ToolCardFrame
        toolName={tr.toolName}
        label={display}
        preview={question || '（问题内容缺失）'}
        busy={waiting}
        expanded={expanded}
        onToggle={() => !waiting && setExpanded((v) => !v)}
        trailing={failed ? <span className="flex-shrink-0 text-meta text-fg-tertiary">未回答</span> : undefined}
      >
        {(expanded || waiting) && (
          <div className="ml-3 min-w-0 space-y-1 border-l border-edge/50 py-1.5 pl-3 pr-1.5 text-body leading-5">
            <div className="min-w-0">
              <span className="text-fg-tertiary">问：</span>
              <span className="whitespace-pre-wrap break-words text-fg-secondary [overflow-wrap:anywhere]">
                {question || '（问题内容缺失）'}
              </span>
            </div>
            {context && (
              <div className="min-w-0 text-meta">
                <button
                  type="button"
                  aria-expanded={showContext}
                  onClick={() => setShowContext((v) => !v)}
                  className="text-fg-tertiary transition-colors hover:text-fg-secondary [@media(pointer:coarse)]:min-h-8"
                >
                  背景信息 {showContext ? '▾' : '▸'}
                </button>
                {showContext && (
                  <p className="whitespace-pre-wrap break-words text-fg-secondary [overflow-wrap:anywhere]">{context}</p>
                )}
              </div>
            )}
            {waiting ? (
              <div className="text-meta text-fg-tertiary" data-testid="ask-parent-waiting">等待主 Agent 回答…</div>
            ) : answer ? (
              <div className="min-w-0">
                <span className="text-fg-tertiary">{failed ? '未回答：' : '答：'}</span>
                <span className="whitespace-pre-wrap break-words text-fg-secondary [overflow-wrap:anywhere]">{answer}</span>
              </div>
            ) : null}
          </div>
        )}
      </ToolCardFrame>
    </div>
  );
}

export default memo(AskParentExchange) as (props: ToolViewProps) => JSX.Element | null;
