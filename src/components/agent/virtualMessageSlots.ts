import type { AgentMessage } from '@/lib/types';
import { isTurnStart } from '@/lib/agentTurnFold';
import { messageGroup, type MessageRow } from './agentMessageRows';

export interface MessageSlot { key: string; row?: MessageRow; rows?: MessageRow[] }

/** Virtua caches sizes by index. Folding must change a slot's height, never its index. */
export function virtualMessageSlots(messages: readonly AgentMessage[], rows: readonly MessageRow[]): MessageSlot[] {
  const visible = new Map(rows.map((row) => [row.key, row]));
  // A disclosure's children must share normal flow. Independent absolute virtual
  // items use delayed ResizeObserver offsets and overlap during height animation.
  const owners = new Map<string, string>();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (row.kind !== 'group') continue;
    for (let next = index + 1; next < rows.length; next++) {
      const child = rows[next];
      if (child.kind !== 'message' || !messageGroup(child.message)) break;
      owners.set(child.key, row.key);
    }
  }
  for (const row of rows) {
    if (row.kind !== 'turn') continue;
    const members = new Set(row.segment.foldMembers.map((message) => `message:${message.id}`));
    for (const child of rows) {
      if (members.has(child.key) || (child.kind === 'group'
        && child.messages.some((message) => members.has(`message:${message.id}`)))) owners.set(child.key, row.key);
    }
  }
  const collections = new Map<string, MessageRow[]>();
  for (const row of rows) {
    let owner = owners.get(row.key) ?? row.key;
    while (owners.has(owner)) owner = owners.get(owner)!;
    const collection = collections.get(owner) ?? [];
    collection.push(row);
    collections.set(owner, collection);
  }
  const slots: MessageSlot[] = [];
  const add = (key: string) => slots.push({ key, row: owners.has(key) ? undefined : visible.get(key), rows: collections.get(key) });
  for (const message of messages) {
    // Reserve before the very first completion: a later tool/result cannot insert a slot.
    if (message.role === 'tool') add(`group:tools:${message.id}`);
    add(`message:${message.id}`);
    if (isTurnStart(message)) add(`turn:u:${message.id}`);
  }
  return slots;
}
