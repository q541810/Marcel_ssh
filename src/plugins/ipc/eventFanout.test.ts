import { beforeEach, describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

import {
  subscribeEvents,
  removePluginSubscriptions,
  unsubscribeEvents,
} from './eventFanout';

describe('eventFanout', () => {
  beforeEach(() => {
    removePluginSubscriptions('p1');
    removePluginSubscriptions('p2');
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
});
