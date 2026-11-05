import { createContext } from 'react';

/**
 * 「这块消息流是一条可跳转的 live 对话」的上下文，由 `AgentTranscript` 提供。
 * 消息流里的卡片（文件路径链接等）据此知道自己属于哪个对话；历史预览、记忆助手这类
 * 只读列表没有提供者。
 */
export interface MessageJumpScope {
  readonly conversationId: string;
}

export const MessageJumpContext = createContext<MessageJumpScope | null>(null);
