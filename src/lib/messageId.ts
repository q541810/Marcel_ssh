import type { AgentMessage } from '@/lib/types';

/** 前端 live id 与库 id 是两个域：同一条消息两个 id 任一相等都算命中（`dbId ?? id` 口径）。 */
export function messageMatchesId(message: AgentMessage, id: string): boolean {
  return message.id === id || message.dbId === id;
}
