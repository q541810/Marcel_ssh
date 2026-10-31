/**
 * visibleTranscriptStore —— 「此刻有哪些对话正显示在可见的对话面板里」。
 *
 * 纯内存登记表（manager 级事实来源）：`AgentTranscript` 在「可见 + 能交互 + 绑定了
 * 对话」时登记自己、否则撤销。桌面 AgentPanel 收起会卸载（登记自然撤销），手机端
 * 切到终端 / 文件页时 `visible=false`（撤销）。提问放哪儿（`questionPlacement`）读它。
 *
 * 用实例 id 而不是对话 id 做键：同一对话理论上可被两个面板同时显示，各自登记各自
 * 撤销，互不吃掉对方的登记。
 */
import { useEffect, useMemo } from 'react';
import { create } from 'zustand';

interface VisibleTranscriptState {
  /** 实例 id → 它正显示的对话 id。 */
  readonly byInstance: Readonly<Record<string, string>>;
  register: (instanceId: string, conversationId: string) => void;
  unregister: (instanceId: string) => void;
}

export const useVisibleTranscriptStore = create<VisibleTranscriptState>((set) => ({
  byInstance: {},
  register: (instanceId, conversationId) =>
    set((s) =>
      s.byInstance[instanceId] === conversationId
        ? s
        : { byInstance: { ...s.byInstance, [instanceId]: conversationId } },
    ),
  unregister: (instanceId) =>
    set((s) => {
      if (!(instanceId in s.byInstance)) return s;
      const next = { ...s.byInstance };
      delete next[instanceId];
      return { byInstance: next };
    }),
}));

/** 当前可见的对话 id 集合（给 `shouldShowQuestionInline`）。引用随登记变化才变。 */
export function useVisibleConversationIds(): ReadonlySet<string> {
  const byInstance = useVisibleTranscriptStore((s) => s.byInstance);
  return useMemo(() => new Set(Object.values(byInstance)), [byInstance]);
}

let nextInstance = 0;

/** 对话面板调用：`active` 为真时登记「我正显示 conversationId」，卸载 / 变化时撤销。 */
export function useRegisterVisibleTranscript(conversationId: string | null, active: boolean): void {
  useEffect(() => {
    if (!active || !conversationId) return;
    const id = `transcript:${nextInstance++}`;
    useVisibleTranscriptStore.getState().register(id, conversationId);
    return () => useVisibleTranscriptStore.getState().unregister(id);
  }, [conversationId, active]);
}
