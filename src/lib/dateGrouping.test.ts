import { describe, it, expect } from 'vitest';
import { groupConversationsByDate, TIME_GROUP_LABELS } from './dateGrouping';

describe('groupConversationsByDate', () => {
  const baseNow = new Date('2026-04-10T12:00:00.000Z');

  it('groups items correctly into today, yesterday, 7 days, 30 days and earlier', () => {
    const items = [
      { id: '1', title: 'Today Item', updatedAt: '2026-04-10T08:00:00.000Z' },
      { id: '2', title: 'Yesterday Item', updatedAt: '2026-04-09T20:00:00.000Z' },
      { id: '3', title: '5 Days Ago Item', updatedAt: '2026-04-05T10:00:00.000Z' },
      { id: '4', title: '20 Days Ago Item', updatedAt: '2026-03-25T10:00:00.000Z' },
      { id: '5', title: '2 Months Ago Item', updatedAt: '2026-02-01T10:00:00.000Z' },
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
      { id: '1', title: 'Today Item', updatedAt: '2026-04-10T08:00:00.000Z' },
      { id: '5', title: 'Old Item', updatedAt: '2025-01-01T10:00:00.000Z' },
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
