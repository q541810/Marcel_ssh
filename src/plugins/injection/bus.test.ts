import { describe, it, expect, beforeEach } from 'vitest';
import { bus } from './bus';

describe('injection event bus', () => {
  beforeEach(() => {
    bus.clear();
  });

  it('delivers events to handlers', () => {
    const received: unknown[] = [];
    bus.on('test:event', (d) => received.push(d));
    bus.emit('test:event', { a: 1 });
    expect(received).toEqual([{ a: 1 }]);
  });

  it('unsubscribe stops delivery', () => {
    const received: unknown[] = [];
    const off = bus.on('test:event2', (d) => received.push(d));
    off();
    bus.emit('test:event2', 'x');
    expect(received).toEqual([]);
  });

  it('handler errors do not stop other handlers', () => {
    const order: string[] = [];
    bus.on('test:event3', () => {
      order.push('a');
      throw new Error('boom');
    });
    bus.on('test:event3', () => order.push('b'));
    bus.emit('test:event3');
    expect(order).toEqual(['a', 'b']);
  });

  it('emit with no handlers is a no-op', () => {
    expect(() => bus.emit('nobody:listening')).not.toThrow();
  });
});
