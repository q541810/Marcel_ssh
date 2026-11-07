import { ChevronRight } from 'lucide-react';

/**
 * 审批来自哪个会话 / 哪个对话，以及「跳转查看」的出口。
 *
 * 名字只是一行灰色小字，不画框。**「跳转查看」按钮始终给**（只要调用方能跳）：
 * 审批弹窗盖着对话，用户看审批时最常需要的就是「先回去看看它是在做什么」——
 * 来自其他会话时是切过去，就在当前会话时是把弹窗收起来露出对话。按钮要看得出是
 * 按钮（淡底 + 细边 + 箭头），但不用彩色抢戏。点击事件原样交给调用方（飞入动画
 * 要用点击坐标）。桌面审批弹窗与手机审批底部面板共用。
 */
export function ApprovalOrigin({
  sessionName,
  conversationTitle,
  isCurrentContext,
  onNavigateToContext,
  compact,
}: {
  sessionName?: string;
  conversationTitle?: string;
  isCurrentContext: boolean;
  onNavigateToContext?: (e?: React.MouseEvent) => void;
  /** 手机：跳转点击区更大。 */
  compact?: boolean;
}) {
  const hasNames = !!sessionName || !!conversationTitle;
  if (!hasNames && !onNavigateToContext) return null;

  return (
    <div className="flex items-center justify-between gap-3 text-meta text-fg-tertiary">
      <span className="min-w-0 truncate">
        {!isCurrentContext && <span>来自其他会话 · </span>}
        <span className="text-fg-secondary">{sessionName || 'SSH 会话'}</span>
        {conversationTitle && <span> · {conversationTitle}</span>}
      </span>
      {onNavigateToContext && (
        <button
          type="button"
          onClick={onNavigateToContext}
          title={
            isCurrentContext ? '收起审批，回到对话查看上下文' : '切到发起这条审批的会话查看上下文'
          }
          className={`inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-edge bg-state-soft pl-2.5 pr-1.5 font-medium text-fg transition-colors hover:bg-state-mid active:bg-state-strong ${
            compact ? 'py-1.5' : 'py-1'
          }`}
        >
          跳转查看
          <ChevronRight className="h-3.5 w-3.5 text-fg-secondary" aria-hidden />
        </button>
      )}
    </div>
  );
}
