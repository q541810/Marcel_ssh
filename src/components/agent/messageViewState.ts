import { createContext, useCallback, useContext, useRef, useState, type SetStateAction } from 'react';

export type MessageViewCache = Map<string, Map<string, unknown>>;
export const MessageViewCacheContext = createContext<MessageViewCache | null>(null);
export const MessageViewIdContext = createContext<string | null>(null);

/** List-local UI state survives virtual unmounts; it never writes conversation data. */
export function useMessageViewState<T>(field: string, initial: T) {
  const cache = useContext(MessageViewCacheContext);
  const id = useContext(MessageViewIdContext);
  const [value, setValue] = useState<T>(() => {
    const fields = id ? cache?.get(id) : undefined;
    return fields?.has(field) ? fields.get(field) as T : initial;
  });
  const current = useRef(value);
  current.current = value;
  const update = useCallback((action: SetStateAction<T>) => {
    const next = typeof action === 'function'
      ? (action as (previous: T) => T)(current.current)
      : action;
    current.current = next;
    if (cache && id) {
      const fields = cache.get(id) ?? new Map<string, unknown>();
      fields.set(field, next);
      cache.set(id, fields);
    }
    setValue(next);
  }, [cache, id, field]);
  return [value, update] as const;
}
