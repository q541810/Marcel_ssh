import { useEffect, useState } from 'react';
import * as tauri from '@/lib/tauri';

/**
 * 这台服务器名下有几条对话（含已归档的）。删服务器的确认框据此告诉用户「N 条对话会留在
 * 历史页的『已删除的服务器』里」，并决定要不要给「同时彻底删除对话」那个复选框
 * （0 条就不显示）。数不出来按 0 处理：对话照常归档保留，只是少一个选项。
 */
export function useConnectionConversationCount(connectionId: string | null): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    setCount(0);
    if (!connectionId) return;
    let alive = true;
    void (async () => {
      try {
        const [active, archived] = await Promise.all([
          tauri.agentListConversationsByConnection(connectionId),
          tauri.agentListArchivedConversations(connectionId),
        ]);
        if (alive) setCount(active.length + archived.length);
      } catch {
        /* 数不出来就不提供「同时删除对话」：对话照常归档保留 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [connectionId]);
  return count;
}
