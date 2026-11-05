/**
 * messageJumpStore —— 「跳到消息流里某一行」的唯一请求通道。
 *
 * 入口只管发请求，真正执行的是持有该对话消息流的 `AgentTranscript`（它认识消息、折叠
 * 和虚拟列表）：对话还没切过来 / 消息还没载入时请求会留着，等对话显示出来再落地；
 * 过期（`JUMP_TTL_MS`）未落地的丢弃，免得很久以后换个对话时凭空乱跳。
 *
 * 请求里只带调用 id / 子对话 id，**消息在执行时才解析**——live 与落库的消息 id 是两个域，
 * 重载后 id 会变，调用 id 才是稳定的。
 *
 * 目标有两种（`kind`），同一条通路、同一个执行器，不要另写滚动：
 * - `tool`：某次工具调用本身的那一行（子对话里的 ask_parent 气泡）；
 * - `thread`：某个子对话在主对话里的时间线卡（子对话的「回到主对话」）。
 */
import { create } from 'zustand';

export const JUMP_TTL_MS = 5000;

export type MessageJumpKind = 'tool' | 'thread';

export interface MessageJumpRequest {
  readonly seq: number;
  readonly conversationId: string;
  readonly kind: MessageJumpKind;
  /** tool：要对准的那次调用 id；thread：子对话 id。 */
  readonly toolCallId: string;
  readonly requestedAt: number;
}

interface MessageJumpState {
  readonly request: MessageJumpRequest | null;
  submit: (r: Omit<MessageJumpRequest, 'seq' | 'requestedAt'>) => void;
  /** 执行方落地（或放弃）后清掉；seq 对不上说明已被新请求顶替，不动。 */
  settle: (seq: number) => void;
}

let seq = 0;

export const useMessageJumpStore = create<MessageJumpState>((set) => ({
  request: null,
  submit: (r) => set({ request: { ...r, seq: ++seq, requestedAt: Date.now() } }),
  settle: (s) => set((state) => (state.request?.seq === s ? { request: null } : state)),
}));

/** 发起一次「跳到某次工具调用那一行」（如子对话里的 ask_parent 气泡）。 */
export function requestToolCallJump(conversationId: string, toolCallId: string): void {
  if (!conversationId || !toolCallId) return;
  useMessageJumpStore.getState().submit({ conversationId, toolCallId, kind: 'tool' });
}

/** 发起一次「跳到某个子对话的时间线卡」（主对话里）。 */
export function requestSubagentThreadJump(conversationId: string, subConversationId: string): void {
  if (!conversationId || !subConversationId) return;
  useMessageJumpStore.getState().submit({ conversationId, toolCallId: subConversationId, kind: 'thread' });
}
