import { useCallback, useMemo, useState } from 'react';
import type { MessageRow } from './agentMessageRows';

export const TOOL_FOLD_DURATION = 280;
type Exit = { row: MessageRow; owner: string; before?: string };

/** Only retain rows absorbed by an actual closed group/turn, never deleted history. */
export function collectToolExits(previous: readonly MessageRow[], next: readonly MessageRow[]) {
  const visible = new Set(next.map((row) => row.key));
  const hidden = new Map<string, string>();
  for (const row of next) {
    const members = row.kind === 'group' && !row.open ? row.messages
      : row.kind === 'turn' && !row.open ? row.segment.foldMembers : [];
    for (const message of members) {
      if (!message.isExecuting && !message.isLoading && !message.isThinking) {
        hidden.set(`message:${message.id}`, row.key);
      }
    }
  }
  return previous.flatMap((row) => {
    const owner = row.kind === 'group'
      ? row.messages.map((message) => hidden.get(`message:${message.id}`)).find(Boolean)
      : hidden.get(row.key);
    return owner && !visible.has(row.key) ? [{ row, owner }] : [];
  });
}

function mergeExits(target: MessageRow[], exits: Exit[]) {
  if (!exits.length) return target;
  return [...target.flatMap((row) => [
    ...exits.filter((exit) => exit.before === row.key).map((exit) => exit.row), row,
  ]), ...exits.filter((exit) => !exit.before).map((exit) => exit.row)];
}

/** Both fold levels share presence; actual animation completion owns unmounting. */
export function useToolFoldTransition(target: MessageRow[], mountedKeys?: ReadonlySet<string>) {
  const [state, setState] = useState<{
    target: MessageRow[]; exits: Exit[]; entering: Set<string>; entryGroups: Map<string, string>;
  }>({ target, exits: [], entering: new Set(), entryGroups: new Map() });
  let current = state;
  if (state.target !== target) {
    const reduced = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const previous = mergeExits(state.target, state.exits);
    const keys = new Set(target.map((row) => row.key));
    const exits: Exit[] = reduced ? [] : collectToolExits(previous, target)
      .filter(({ row }) => !mountedKeys || mountedKeys.has(row.key))
      .map((exit) => {
        const index = previous.findIndex((row) => row.key === exit.row.key);
        // Keep chronological placement; never move every exiting row under the header.
        const before = previous.slice(index + 1).find((row) => keys.has(row.key))?.key;
        return { ...exit, before };
      });
    const entering = reduced ? new Set<string>()
      : new Set([...state.entering].filter((key) => keys.has(key)));
    const entryGroups = new Map([...state.entryGroups].filter(([key]) => entering.has(key)));
    if (!reduced) {
      for (const { row, owner } of collectToolExits(target, state.target)) {
        entering.add(row.key);
        entryGroups.set(row.key, owner);
      }
      for (const exit of state.exits) if (keys.has(exit.row.key)) {
        entering.add(exit.row.key);
        entryGroups.set(exit.row.key, exit.owner);
      }
      // A newly introduced summary takes up space too; reveal it with its members.
      for (const row of target) if (row.kind === 'group'
        && !state.target.some((old) => old.key === row.key)
        && row.messages.some((message) => previous.some((old) => old.key === `message:${message.id}`))) {
        entering.add(row.key);
        entryGroups.set(row.key, row.key);
      }
    }
    current = { target, exits, entering, entryGroups };
    setState(current);
  }
  const onExitComplete = useCallback((key: string) => setState((old) =>
    old.exits.some((exit) => exit.row.key === key)
      ? { ...old, exits: old.exits.filter((exit) => exit.row.key !== key) } : old), []);
  const onEnterComplete = useCallback((key: string) => setState((old) => {
    if (!old.entering.has(key)) return old;
    const entering = new Set(old.entering);
    entering.delete(key);
    const entryGroups = new Map(old.entryGroups);
    entryGroups.delete(key);
    return { ...old, entering, entryGroups };
  }), []);
  const { exits, entering, entryGroups } = current;
  return useMemo(() => ({
    rows: mergeExits(target, exits),
    exiting: new Set(exits.map((exit) => exit.row.key)), entering, entryGroups,
    exitGroups: new Map(exits.map((exit) => [exit.row.key, exit.owner])),
    onExitComplete, onEnterComplete,
  }), [target, exits, entering, entryGroups, onExitComplete, onEnterComplete]);
}
