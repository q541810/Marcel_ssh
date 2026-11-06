import { useCallback, useEffect, useRef, useState } from 'react';
import { useTaskStore } from '@/stores/taskStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useInteractionStore } from '@/stores/interactionStore';
import type { MascotState } from '@/lib/mascot/frames';
import {
  conversationActivity,
  initialMood,
  latestOutcome,
  stepMood,
  wakeMood,
  type MascotActivity,
  type MoodState,
  type MoodStep,
} from '@/lib/mascot/mood';

/**
 * 玛瑟尔的「导演」（manager）：协调任务表、子对话、前台审批 / 提问三路状态，交给纯函数
 * `stepMood` 定动作，并按它给的 `wakeAt` 安排计时器（防闪烁的等待、结局播完、到点睡着）。
 *
 * 订阅只取算好的原始值（活动字符串、结局字符串、子对话 id 串），流式输出 token 这类高频变化
 * 不会让它重渲染。以后任务状态多了新成员，`conversationActivity` 里用的是 `lib/agentStatus`
 * 的分类谓词，那边的穷尽 switch 会先报错。
 */
export function useMascotMood(conversationId: string | null): { state: MascotState; poke: () => void } {
  // 子对话（子 agent）也算这个对话的动静：和对话列表状态点同口径
  const childIds = useConversationStore((s) => {
    if (!conversationId) return '';
    const ids: string[] = [];
    for (const c of Object.values(s.conversations)) {
      if (c.parentConversationId === conversationId) ids.push(c.id);
    }
    return ids.sort().join('\n');
  });
  const interactionKey = useInteractionStore((s) => {
    const it = s.currentInteraction;
    return it ? `${it.kind}\n${it.conversationId}` : '';
  });

  const activity = useTaskStore((s): MascotActivity => {
    if (!conversationId) return 'idle';
    const family = new Set([conversationId, ...(childIds ? childIds.split('\n') : [])]);
    // 排除重启恢复的占位任务（sessionId 为空串），与 getConversationAgentStatus 同口径
    const tasks = Object.values(s.tasks).filter((t) => family.has(t.conversationId) && !!t.sessionId);
    const [kind, convId] = interactionKey ? interactionKey.split('\n') : [];
    return conversationActivity(
      tasks,
      family,
      kind ? { kind: kind as 'approval' | 'question', conversationId: convId } : null,
    );
  });
  const outcome = useTaskStore((s) => (conversationId ? latestOutcome(Object.values(s.tasks), conversationId) : null));

  const moodRef = useRef<MoodState>(initialMood(activity, Date.now()));
  const [shown, setShown] = useState<MascotState>(moodRef.current.shown);
  const timerRef = useRef<number | null>(null);
  const inputRef = useRef({ activity, outcome });
  inputRef.current = { activity, outcome };

  const apply = useCallback((step: MoodStep) => {
    moodRef.current = step.state;
    setShown(step.state.shown);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    if (step.wakeAt !== null) {
      const delay = Math.max(0, step.wakeAt - Date.now());
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        apply(stepMood(moodRef.current, { ...inputRef.current, now: Date.now() }));
      }, delay);
    }
  }, []);

  // 换对话：重新开始，不继承上一个对话的结局（切到早就做完的对话不该庆祝）
  const lastConversation = useRef(conversationId);
  useEffect(() => {
    if (lastConversation.current === conversationId) return;
    lastConversation.current = conversationId;
    const now = Date.now();
    apply(stepMood(initialMood(inputRef.current.activity, now), { ...inputRef.current, now }));
  }, [conversationId, apply]);

  useEffect(() => {
    apply(stepMood(moodRef.current, { activity, outcome, now: Date.now() }));
  }, [activity, outcome, apply]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  const poke = useCallback(() => {
    const step = wakeMood(moodRef.current, Date.now());
    // 正在干活 / 播结局时戳它不改状态；也别 apply——那会把正在等的计时器（停下确认、结局播完）清掉
    if (step.state !== moodRef.current) apply(step);
  }, [apply]);
  return { state: shown, poke };
}
