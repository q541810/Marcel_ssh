import { describe, it, expect } from 'vitest';
import { groupConversationsByDate, TIME_GROUP_LABELS } from './dateGrouping';

describe('groupConversationsByDate', () => {
  // Use local-timezone-aware dates to avoid UTC/local mismatch
  const baseNow = new Date(2026, 3, 10, 12, 0, 0);

  it('groups items correctly into today, yesterday, 7 days, 30 days and earlier', () => {
    const items = [
      { id: '1', title: 'Today Item', updatedAt: new Date(2026, 3, 10, 8, 0, 0).toISOString() },
      { id: '2', title: 'Yesterday Item', updatedAt: new Date(2026, 3, 9, 10, 0, 0).toISOString() },
      { id: '3', title: '5 Days Ago Item', updatedAt: new Date(2026, 3, 5, 10, 0, 0).toISOString() },
      { id: '4', title: '20 Days Ago Item', updatedAt: new Date(2026, 2, 21, 10, 0, 0).toISOString() },
      { id: '5', title: '2 Months Ago Item', updatedAt: new Date(2026, 1, 1, 10, 0, 0).toISOString() },
    ];

    const groups = groupConversationsByDate(items, baseNow);

    expect(groups).toHaveLength(5);
    expect(groups[0].key).toBe('today');
    expect(groups[0].label).toBe(TIME_GROUP_LABELS.today);
    expect(groups[0].items.map((i) => i.id)).toEqual(['1']);

    expect(groups[1].key).toBe('yesterday');
    expect(groups[1].label).toBe(TIME_GROUP_LABELS.yesterday);
    expect(groups[1].items.map((i) => i.id)).toEqual(['2']);

    expect(groups[2].key).toBe('within7Days');
    expect(groups[2].label).toBe(TIME_GROUP_LABELS.within7Days);
    expect(groups[2].items.map((i) => i.id)).toEqual(['3']);

    expect(groups[3].key).toBe('within30Days');
    expect(groups[3].label).toBe(TIME_GROUP_LABELS.within30Days);
    expect(groups[3].items.map((i) => i.id)).toEqual(['4']);

    expect(groups[4].key).toBe('earlier');
    expect(groups[4].label).toBe(TIME_GROUP_LABELS.earlier);
    expect(groups[4].items.map((i) => i.id)).toEqual(['5']);
  });

  it('skips empty groups', () => {
    const items = [
      { id: '1', title: 'Today Item', updatedAt: new Date(2026, 3, 10, 8, 0, 0).toISOString() },
      { id: '5', title: 'Old Item', updatedAt: new Date(2025, 0, 1, 10, 0, 0).toISOString() },
    ];

    const groups = groupConversationsByDate(items, baseNow);

    expect(groups).toHaveLength(2);
    expect(groups[0].key).toBe('today');
    expect(groups[1].key).toBe('earlier');
  });

  it('handles invalid or missing date gracefully as earlier', () => {
    const items = [
      { id: '1', title: 'No Date' },
      { id: '2', title: 'Invalid Date', updatedAt: 'invalid-date' },
    ];

    const groups = groupConversationsByDate(items, baseNow);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('earlier');
    expect(groups[0].items).toHaveLength(2);
  });
});
