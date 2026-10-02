import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { useTaskStore } from '@/stores/taskStore';

/** Draft updates belong to the composer, not the transcript or its host. */
export function AgentDraft({ children }: { children: (draft: string) => ReactNode }) {
  const draft = useTaskStore((s) => s.inputDraft);
  return children(draft);
}

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & {
  maxHeight: number;
  onTyping?: () => void;
};

export const AgentTextarea = forwardRef<HTMLTextAreaElement, Props>(
  function AgentTextarea({ maxHeight, onTyping, ...props }, forwardedRef) {
    const draft = useTaskStore((s) => s.inputDraft);
    const setDraft = useTaskStore((s) => s.setInputDraft);
    const ref = useRef<HTMLTextAreaElement | null>(null);
    // One measurement after the value is committed, including restore/clear/attachments.
    const resize = useCallback(() => {
      const node = ref.current;
      if (!node) return;
      node.style.height = 'auto';
      node.style.height = `${Math.min(node.scrollHeight, maxHeight)}px`;
    }, [maxHeight]);
    useLayoutEffect(resize, [draft, resize]);
    useEffect(() => {
      const node = ref.current;
      if (!node || typeof ResizeObserver === 'undefined') return;
      let width = node.clientWidth;
      const observer = new ResizeObserver(() => {
        const nextWidth = node.clientWidth;
        if (nextWidth === width) return;
        width = nextWidth;
        resize();
      });
      observer.observe(node);
      return () => observer.disconnect();
    }, [resize]);

    return <textarea
      {...props}
      ref={(node) => {
        ref.current = node;
        if (typeof forwardedRef === 'function') forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      }}
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        onTyping?.();
      }}
    />;
  },
);
