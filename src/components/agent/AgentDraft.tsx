import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { EMPTY_DRAFT, useAgentDraftStore } from '@/stores/agentDraftStore';

/** Draft updates belong to the composer, not the transcript or its host. */
export function AgentDraft({ draftKey, children }: { draftKey: string; children: (draft: string) => ReactNode }) {
  const draft = useAgentDraftStore((s) => (s.drafts[draftKey] ?? EMPTY_DRAFT).text);
  return children(draft);
}

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & {
  draftKey: string;
  maxHeight: number;
  onTyping?: () => void;
};

export const AgentTextarea = forwardRef<HTMLTextAreaElement, Props>(
  function AgentTextarea({ draftKey, maxHeight, onTyping, ...props }, forwardedRef) {
    const draft = useAgentDraftStore((s) => (s.drafts[draftKey] ?? EMPTY_DRAFT).text);
    const setDraft = useAgentDraftStore((s) => s.setText);
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
        setDraft(draftKey, event.target.value);
        onTyping?.();
      }}
    />;
  },
);
