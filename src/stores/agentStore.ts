export { useTaskStore } from './taskStore';
export { useConversationStore } from './conversationStore';

import { useTaskStore } from './taskStore';
import { useConversationStore } from './conversationStore';
import type { TaskState } from './taskStore';
import type { ConversationState } from './conversationStore';

type AgentState = TaskState & ConversationState;

export function useAgentStore<T>(selector: (state: AgentState) => T): T {
  const taskState = useTaskStore();
  const convState = useConversationStore();
  return selector({ ...taskState, ...convState } as AgentState);
}
