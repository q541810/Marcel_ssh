import { useState } from 'react';
import { Bookmark } from 'lucide-react';
import { useSessionStore } from '@/stores/sessionStore';
import { InjectedMemoryList } from '@/components/memory/InjectedMemories';
import { useInjectedMemories } from '@/components/memory/useInjectedMemories';

/**
 * Agent 面板头部的「记忆 N」：这段对话带着几条记忆，点开看是哪些、去管理。
 *
 * 让「模型这次到底知道什么」看得见 —— 记忆影响 Agent 的判断，用户得能随时核对。
 */
export function MemoryIndicator({
  conversationId,
  disabled: offline = false,
}: {
  conversationId: string | null;
  /** 没连上服务器：没有「这段对话」可言，按钮置灰（与头部其它按钮一致）。 */
  disabled?: boolean;
}) {
  const [openState, setOpen] = useState(false);
  const open = openState && !offline;
  const session = useSessionStore((s) => (s.activeSessionId ? (s.sessions[s.activeSessionId] ?? null) : null));
  const { data, error } = useInjectedMemories(conversationId, session?.id ?? null);
  const count = data?.items.length ?? 0;
  const disabled = offline || (data ? !data.enabled : false);
  const focus = session?.configId ? { scope: 'host' as const, key: session.configId } : undefined;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={offline}
        aria-expanded={open}
        aria-label="这段对话带着的记忆"
        title={offline ? '连接服务器后可查看' : disabled ? '长期记忆已关闭' : `这段对话带着 ${count} 条记忆`}
        className={`flex h-7 items-center gap-1 rounded px-1.5 text-meta transition-colors pressable disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-fg-secondary ${
          open ? 'bg-state-mid text-fg' : 'text-fg-secondary hover:bg-state-mid hover:text-fg'
        } ${!offline && disabled ? 'opacity-50' : ''}`}
      >
        <Bookmark className="h-3.5 w-3.5" aria-hidden />
        {!disabled && count > 0 && <span className="tabular-nums">{count}</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-2 flex max-h-[min(28rem,70vh)] w-72 flex-col overflow-hidden origin-top-right rounded-xl surface-glass p-3 text-meta animate-fadeIn">
            <div className="mb-2 shrink-0 border-b border-edge pb-1.5 font-semibold text-fg-secondary">记忆</div>
            <InjectedMemoryList data={data} error={error} focus={focus} onNavigate={() => setOpen(false)} />
          </div>
        </>
      )}
    </div>
  );
}
