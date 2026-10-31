/**
 * useMessageJump —— 「滚到某条消息的正文（可对准其中一个小标题）并闪一下」的执行器。
 *
 * 消息列表是虚拟化的：目标行可能还没挂载、所在的折叠回合可能还没展开、目标高度还没
 * 量出来。所以这里分三步，每一步都容忍"还没好"：
 * 1. 等 `slots` 里出现目标行（折叠展开 / 窗口扩大之后才会出现）→ `scrollToIndex` 让虚拟列表
 *    先把它挂载出来；
 * 2. 逐帧等 DOM 里出现目标消息，找到后把「小标题（有 anchor 且找得到）或消息顶部」
 *    对齐到滚动容器顶部，行高在测量中会变，所以对齐到误差收敛为止；
 * 3. 对齐的块闪一下。
 * 找不到小标题就退回消息开头；一直等不到目标（比如被别的变更顶掉）则放弃，不乱滚。
 *
 * 所有"跳到消息文本"的调用方（提问卡片、全局浮层、手机浮动条、已回答记录）最终都
 * 走这里（经 `messageJumpStore` → `AgentTranscript` → 列表句柄），不要再各写一套。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { VirtualizerHandle } from 'virtua';
import { findAnchorHeading } from '@/lib/questionJump';
import { flashElement } from '@/lib/flashElement';
import type { MessageSlot } from './virtualMessageSlots';

const GIVE_UP_MS = 3000;
const ALIGN_FRAMES = 14;
/** 目标贴着滚动容器顶部时留的呼吸空间。 */
const TOP_GAP = 12;
/** 有 anchor 但标题还没渲染出来时，最多再等几帧才退回消息开头。 */
const HEADING_WAIT_FRAMES = 6;

interface Pending {
  readonly id: string;
  readonly anchor?: string;
  readonly token: number;
}

interface Options {
  root: RefObject<HTMLElement | null>;
  scrollRef: RefObject<HTMLElement | null>;
  virtualizer: RefObject<VirtualizerHandle | null>;
  slots: readonly MessageSlot[];
}

export function useMessageJump({ root, scrollRef, virtualizer, slots }: Options) {
  const [pending, setPending] = useState<Pending | null>(null);
  const counter = useRef(0);

  const start = useCallback((id: string, anchor?: string) => {
    setPending({ id, anchor, token: ++counter.current });
  }, []);

  // 放弃计时：目标一直没出现（被撤回、被别的变更顶掉……）就不再等
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(
      () => setPending((p) => (p?.token === pending.token ? null : p)),
      GIVE_UP_MS,
    );
    return () => clearTimeout(timer);
  }, [pending]);

  const slotIndex = pending
    ? slots.findIndex((slot) =>
        slot.rows?.some((row) => row.kind === 'message' && row.message.id === pending.id),
      )
    : -1;

  useEffect(() => {
    if (!pending || slotIndex < 0) return;
    const { id, anchor, token } = pending;
    let cancelled = false;
    let frame = 0;

    if (virtualizer.current) virtualizer.current.scrollToIndex(slotIndex, { align: 'start' });
    else
      root.current
        ?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView?.({ block: 'start' });

    let waited = 0;
    let settled = 0;
    const step = () => {
      if (cancelled) return;
      frame = requestAnimationFrame(step);
      waited += 1;
      const scroll = scrollRef.current;
      const message = root.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
      if (!scroll || !message) {
        if (waited > ALIGN_FRAMES * 3) finish();
        return;
      }
      const heading = anchor ? findAnchorHeading(message, anchor) : null;
      const target = heading ?? message;
      const delta = target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - TOP_GAP;
      if (Math.abs(delta) > 2) {
        scroll.scrollBy({ top: delta });
        settled = 0;
      } else {
        settled += 1;
      }
      const headingPending = !!anchor && !heading && waited < HEADING_WAIT_FRAMES;
      if ((settled >= 2 && !headingPending) || waited >= ALIGN_FRAMES) {
        flashElement(target);
        finish();
      }
    };
    const finish = () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      setPending((p) => (p?.token === token ? null : p));
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [pending, slotIndex, root, scrollRef, virtualizer]);

  return start;
}
