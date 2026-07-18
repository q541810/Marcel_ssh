import { beforeEach, describe, it, expect, vi } from 'vitest';

const eventApi = vi.hoisted(() => ({
  listener: null as ((event: { payload: { event: string; data: unknown } }) => void) | null,
  emit: vi.fn(async () => {}),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, listener: typeof eventApi.listener) => {
    eventApi.listener = listener;
    return () => {};
  }),
  emit: eventApi.emit,
}));

import { subscribeEvents, removePluginSubscriptions, unsubscribeEvents } from './eventFanout';

describe('eventFanout', () => {
  beforeEach(() => {
    removePluginSubscriptions('p1');
    removePluginSubscriptions('p2');
    eventApi.emit.mockClear();
  });

  it('removePluginSubscriptions clears all patterns for a plugin', () => {
    subscribeEvents('p1', ['ssh://status/*', 'ui:nav']);
    subscribeEvents('p2', ['ssh://status/*']);
    removePluginSubscriptions('p1');
    // p1 gone; unsubscribe on empty set is no-op
    expect(unsubscribeEvents('p1', ['ssh://status/*'])).toEqual([]);
    // p2 still has subscription
    expect(unsubscribeEvents('p2', ['ssh://status/*'])).toEqual(['ssh://status/*']);
  });

  it('forwards rapid events with the same name without dropping or reordering them', async () => {
    subscribeEvents('p1', ['agent://stream/*']);
    await vi.waitFor(() => expect(eventApi.listener).not.toBeNull());

    eventApi.listener!({
      payload: { event: 'agent://stream/task-1', data: { text: 'first' } },
    });
    eventApi.listener!({
      payload: { event: 'agent://stream/task-1', data: { text: 'second' } },
    });

    expect(eventApi.emit).toHaveBeenNthCalledWith(1, 'plugin-event-p1', {
      event: 'agent://stream/task-1',
      data: { text: 'first' },
    });
    expect(eventApi.emit).toHaveBeenNthCalledWith(2, 'plugin-event-p1', {
      event: 'agent://stream/task-1',
      data: { text: 'second' },
    });
  });
});
