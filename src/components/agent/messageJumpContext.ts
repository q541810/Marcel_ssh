import { createContext, type MutableRefObject } from 'react';
import type { AgentMessage } from '@/lib/types';

/**
 * 「这块消息流是一条可跳转的 live 对话」的上下文，由 `AgentTranscript` 提供。
 * 消息流里的卡片（如已回答记录）据此判断自己有没有上文可跳、往哪个对话发跳转请求；
 * 历史预览、记忆助手这类只读列表没有提供者，对应按钮自然不出现。
 * 消息走 ref：卡片渲染时读一次最新值即可，不为它订阅消息流（流式期间每帧都在变）。
 */
export interface MessageJumpScope {
  readonly conversationId: string;
  readonly messagesRef: MutableRefObject<readonly AgentMessage[]>;
}

export const MessageJumpContext = createContext<MessageJumpScope | null>(null);
