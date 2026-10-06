import { useCallback, useRef, useState } from 'react';

interface WidthHandleProps {
  side: 'left' | 'right';
  onStart: () => number;
  onDrag: (width: number) => void;
  onCommit: (width: number) => void;
  onEnd: () => void;
  onReset: () => void;
}

/** One transcript width handle: pointer capture + rAF-throttled symmetric
 *  resize (both sides write the one centered width, so outward travel widens
 *  by 2× the pointer distance). pointermove publishes the pointer's Y as a CSS
 *  variable so the glow indicator rides it. 双击复位到自适应宽度。 */
function WidthHandle({ side, onStart, onDrag, onCommit, onEnd, onReset }: WidthHandleProps) {
  const [dragging, setDragging] = useState(false);
  const base = useRef(0);
  const origin = useRef(0);
  const latest = useRef(0);
  const frame = useRef<number | null>(null);
  const callbacks = useRef({ side, onStart, onDrag, onCommit, onEnd, onReset });
  callbacks.current = { side, onStart, onDrag, onCommit, onEnd, onReset };

  const outwardWidth = () => {
    const dx = latest.current - origin.current;
    const outward = callbacks.current.side === 'right' ? dx : -dx;
    return base.current + outward * 2;
  };
  const cancelFrame = () => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
  };
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    origin.current = e.clientX;
    latest.current = e.clientX;
    base.current = callbacks.current.onStart();
    setDragging(true);
  }, []);
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty('--agent-width-handle-pointer-y', `${e.clientY - box.top}px`);
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    latest.current = e.clientX;
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null;
      callbacks.current.onDrag(outwardWidth());
    });
  }, []);
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    cancelFrame();
    latest.current = e.clientX;
    // Only a gesture with actual travel commits: a press-and-release on a
    // window-clamped width must not overwrite the wider stored preference
    // with the clamped display value.
    if (latest.current !== origin.current) callbacks.current.onCommit(outwardWidth());
    setDragging(false);
    callbacks.current.onEnd();
  }, []);
  // Releasing the button outside the window delivers pointercancel (or drops
  // the capture silently) instead of pointerup; without this the glow's
  // data-dragging state sticks on. The gesture is abandoned uncommitted —
  // onEnd republishes the stored preference.
  const onPointerCancel = useCallback(() => {
    cancelFrame();
    setDragging(false);
    callbacks.current.onEnd();
  }, []);

  return (
    <div
      className="agent-width-handle"
      data-side={side}
      data-dragging={dragging ? '' : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onDoubleClick={onReset}
    />
  );
}

interface ContentWidthHandlesProps {
  onStart: () => number;
  onDrag: (width: number) => void;
  onCommit: (width: number) => void;
  onEnd: () => void;
  onReset: () => void;
}

/** 内容列两侧的宽度把手（左右一对）：仅在限宽生效的布局（agentPrimary）
 *  时由 AgentPanel 渲染。 */
export default function ContentWidthHandles(props: ContentWidthHandlesProps) {
  return (
    <>
      <WidthHandle side="left" {...props} />
      <WidthHandle side="right" {...props} />
    </>
  );
}
