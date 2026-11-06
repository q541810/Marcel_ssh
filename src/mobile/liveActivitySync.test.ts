import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveActivityContent } from '@/lib/liveActivity';
import {
  HEARTBEAT_MS,
  MIN_INTERVAL_MS,
  startLiveActivitySync,
} from './liveActivitySync';

const running = (text = '正在干活'): LiveActivityContent => ({
  kind: 'running',
  chip: '运行中',
  title: 'T',
  text,
  since: 1,
});

function setup(initial: LiveActivityContent | null) {
  let value = initial;
  let notify: () => void = () => {};
  const push = vi.fn();
  const clear = vi.fn();
  const stop = startLiveActivitySync({
    current: () => value,
    subscribe: (cb) => {
      notify = cb;
      return () => {};
    },
    push,
    clear,
  });
  return {
    push,
    clear,
    stop,
    set(v: LiveActivityContent | null) {
      value = v;
      notify();
    },
  };
}

describe('startLiveActivitySync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-06T10:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('启动时有内容就推一次', () => {
    const s = setup(running());
    expect(s.push).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it('启动时没内容什么都不做', () => {
    const s = setup(null);
    expect(s.push).not.toHaveBeenCalled();
    expect(s.clear).not.toHaveBeenCalled();
    s.stop();
  });

  it('内容没变不重推', () => {
    const s = setup(running());
    vi.advanceTimersByTime(MIN_INTERVAL_MS + 1);
    s.set(running());
    expect(s.push).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it('间隔内的变化合并成最后一个，到点才推', () => {
    const s = setup(running());
    s.set(running('A'));
    s.set(running('B'));
    expect(s.push).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(MIN_INTERVAL_MS);
    expect(s.push).toHaveBeenCalledTimes(2);
    expect(s.push).toHaveBeenLastCalledWith(running('B'));
    s.stop();
  });

  it('任务结束立刻撤岛，不等间隔，也丢掉排队中的推送', () => {
    const s = setup(running());
    s.set(running('A'));
    s.set(null);
    expect(s.clear).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(MIN_INTERVAL_MS * 2);
    expect(s.push).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it('有内容时周期性重推，防原生超时把岛收掉', () => {
    const s = setup(running());
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(s.push).toHaveBeenCalledTimes(2);
    s.stop();
  });

  it('没内容时不重推', () => {
    const s = setup(null);
    vi.advanceTimersByTime(HEARTBEAT_MS * 2);
    expect(s.push).not.toHaveBeenCalled();
    s.stop();
  });

  it('停止时撤岛并不再响应', () => {
    const s = setup(running());
    s.stop();
    expect(s.clear).toHaveBeenCalledTimes(1);
    s.set(running('X'));
    vi.advanceTimersByTime(MIN_INTERVAL_MS * 2);
    expect(s.push).toHaveBeenCalledTimes(1);
  });
});
