/**
 * messageJumpStore —— 「跳到某条消息的正文（可对准其中某个小标题）」的唯一请求通道。
 *
 * 所有入口（内联提问卡片、全局浮层 / 胶囊、手机浮动条、历史里的「已回答」记录）都只做
 * 一件事：`requestQuestionTextJump`。真正执行的是持有该对话消息流的 `AgentTranscript`
 * （它认识消息、折叠和虚拟列表）：对话还没切过来 / 消息还没载入时请求会留着，等对话
 * 显示出来再落地；过期（`JUMP_TTL_MS`）未落地的丢弃，免得很久以后换个对话时凭空乱跳。
 *
 * 定位目标是「发出该次 ask_user 调用的 assistant 消息的正文」（见 `lib/questionJump`），
 * 请求里只带调用 id 和可选的 anchor，**消息在执行时才解析**——live 与落库的消息 id
 * 是两个域，重载后 id 会变，调用 id 才是稳定的。
 */
import { create } from 'zustand';

export const JUMP_TTL_MS = 5000;

export interface MessageJumpRequest {
  readonly seq: number;
  readonly conversationId: string;
  /** ask_user 的调用 id（即 questionId）。 */
  readonly toolCallId: string;
  /** 要对准的小标题（后端归一化过的原文）；缺省 = 正文开头。 */
  readonly anchor?: string;
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

/** 发起一次「跳到提问前那段正文」。 */
export function requestQuestionTextJump(
  conversationId: string,
  toolCallId: string,
  anchor?: string,
): void {
  if (!conversationId || !toolCallId) return;
  useMessageJumpStore.getState().submit({ conversationId, toolCallId, anchor });
}
