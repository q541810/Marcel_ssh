import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetEventChannelsForTest,
  subscriberCount,
  subscribeTauriEvent,
} from './tauriEvent';

/**
 * 这组测试守的是本仓库反复踩过的两类隐蔽 bug：
 * 「卸载早于 listen() resolve 导致监听器泄漏」与「StrictMode 双挂载导致重复注册」。
 * 两者在真机上只表现为「监听器越来越多」，不影响功能，所以必须靠单测钉住。
 */

/** 可控的假 listen：手动决定何时 resolve，模拟「卸载早于订阅就绪」。 */
let pendingResolvers: Array<(unlisten: () => void) => void>;
let underlyingUnlistens: Array<ReturnType<typeof vi.fn>>;

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    (
      _name: string,
      _cb: (e: { payload: unknown }) => void,
    ): Promise<() => void> =>
      new Promise<() => void>((resolve) => {
        pendingResolvers.push((unlisten) => resolve(unlisten));
      }),
  ),
}));

/** 让所有挂起的 listen() 立即 resolve，并记录它们的 unlisten。 */
function resolveAllListens(): void {
  const resolvers = pendingResolvers;
  pendingResolvers = [];
  for (const resolve of resolvers) {
    const unlisten = vi.fn();
    underlyingUnlistens.push(unlisten);
    resolve(unlisten);
  }
}

describe('subscribeTauriEvent', () => {
  beforeEach(() => {
    resetEventChannelsForTest();
    vi.clearAllMocks();
    pendingResolvers = [];
    underlyingUnlistens = [];
  });

  it('取消订阅早于 listen() resolve 时，就绪后立刻回收监听器', async () => {
    const unsubscribe = subscribeTauriEvent('t://late', () => {});
    // 订阅还没就绪 —— 这正是组件卸载发生的那一刻。
    unsubscribe();

    resolveAllListens();
    await Promise.resolve();
    await Promise.resolve();

    expect(underlyingUnlistens).toHaveLength(1);
    expect(underlyingUnlistens[0]).toHaveBeenCalledTimes(1);
    expect(subscriberCount('t://late')).toBe(0);
  });

  it('重复取消是幂等的，不会重复解绑', async () => {
    const unsubscribe = subscribeTauriEvent('t://idempotent', () => {});
    resolveAllListens();
    await Promise.resolve();
    await Promise.resolve();

    unsubscribe();
    unsubscribe();
    unsubscribe();

    expect(underlyingUnlistens[0]).toHaveBeenCalledTimes(1);
  });

  it('StrictMode 双挂载：先订后退再订，最终只有一条底层监听', async () => {
    const first = subscribeTauriEvent('t://strict', () => {});
    first(); // cleanup
    subscribeTauriEvent('t://strict', () => {});

    resolveAllListens();
    await Promise.resolve();
    await Promise.resolve();

    // 第一次订阅在 resolve 时被回收，第二次订阅建立新的一条。
    expect(subscriberCount('t://strict')).toBe(1);
    expect(
      underlyingUnlistens.filter((fn) => fn.mock.calls.length > 0).length,
    ).toBe(1);
  });

  it('多个处理器共享同一条底层监听，且各自取消互不影响', async () => {
    const seen: string[] = [];
    const unsubA = subscribeTauriEvent<string>('t://shared', (p) =>
      seen.push(`A:${p}`),
    );
    const unsubB = subscribeTauriEvent<string>('t://shared', (p) =>
      seen.push(`B:${p}`),
    );

    resolveAllListens();
    await Promise.resolve();
    await Promise.resolve();

    // 同事件名只占一条事件总线连接。
    expect(underlyingUnlistens).toHaveLength(1);
    expect(subscriberCount('t://shared')).toBe(2);

    unsubA();
    expect(subscriberCount('t://shared')).toBe(1);
    // A 走了不该波及 B：底层监听仍在。
    expect(underlyingUnlistens[0]).not.toHaveBeenCalled();

    // B 也走了才真正解绑。
    unsubB();
    expect(subscriberCount('t://shared')).toBe(0);
    expect(underlyingUnlistens[0]).toHaveBeenCalledTimes(1);
  });

  it('最后一个处理器离开时才真正解绑', async () => {
    const unsubA = subscribeTauriEvent('t://last', () => {});
    const unsubB = subscribeTauriEvent('t://last', () => {});
    resolveAllListens();
    await Promise.resolve();
    await Promise.resolve();

    unsubA();
    expect(underlyingUnlistens[0]).not.toHaveBeenCalled();
    unsubB();
    expect(underlyingUnlistens[0]).toHaveBeenCalledTimes(1);
    expect(subscriberCount('t://last')).toBe(0);
  });

  it('单个处理器抛错不影响同一事件上的其他处理器', async () => {
    const seen: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    subscribeTauriEvent<string>('t://throw', () => {
      throw new Error('boom');
    });
    subscribeTauriEvent<string>('t://throw', (p) => seen.push(p));

    resolveAllListens();
    await Promise.resolve();
    await Promise.resolve();

    // 直接触发底层回调，验证扇出逻辑。
    const [, callback] = vi.mocked(
      (await import('@tauri-apps/api/event')).listen,
    ).mock.calls[0];
    callback({ payload: 'hello' } as never);

    expect(seen).toEqual(['hello']);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('listen 注册失败时不留下「僵尸通道」：后续订阅会重建而不是复用一个空壳', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { listen } = vi.mocked(await import('@tauri-apps/api/event'));
    listen.mockRejectedValueOnce(new Error('no tauri context'));

    subscribeTauriEvent('t://fail', () => {});
    await Promise.resolve();
    await Promise.resolve();

    expect(subscriberCount('t://fail')).toBe(0);
    expect(errorSpy).toHaveBeenCalled();

    // 第二次订阅必须真的再去注册一次（而不是命中失败留下的空壳）。
    listen.mockResolvedValueOnce(vi.fn());
    subscribeTauriEvent('t://fail', () => {});
    expect(listen).toHaveBeenCalledTimes(2);
    expect(subscriberCount('t://fail')).toBe(1);
    errorSpy.mockRestore();
  });

  it('同一个处理器引用被订阅两次时给出开发期告警（Set 会静默吞掉第二次）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sameHandler = () => {};
    subscribeTauriEvent('t://dupe', sameHandler);
    subscribeTauriEvent('t://dupe', sameHandler);

    // 第二次被去重 —— 这正是要告警的原因：订阅者会以为自己订上了。
    expect(subscriberCount('t://dupe')).toBe(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('扇出过程中处理器自我退订，不影响本轮其余处理器', async () => {
    const seen: string[] = [];
    const unsubscribeSelf = subscribeTauriEvent<string>('t://self-off', (p) => {
      seen.push(`self:${p}`);
      unsubscribeSelf();
    });
    subscribeTauriEvent<string>('t://self-off', (p) => seen.push(`other:${p}`));

    resolveAllListens();
    await Promise.resolve();
    await Promise.resolve();

    const [, callback] = vi.mocked(
      (await import('@tauri-apps/api/event')).listen,
    ).mock.calls[0];
    callback({ payload: 'x' } as never);
    callback({ payload: 'y' } as never);

    // 第一轮两个都收到；自我退订后第二轮只剩 another —— 且第一轮不能因为
    // 遍历中途修改集合而漏掉 other。（实现靠 [...handlers] 复制保证。）
    expect(seen).toEqual(['self:x', 'other:x', 'other:y']);
  });

  it('孤儿通道的退订不会误伤重建后的新通道', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { listen } = vi.mocked(await import('@tauri-apps/api/event'));

    // 一条订阅，让它的注册失败 → 通道被摘除，但退订函数还在调用方手里。
    listen.mockRejectedValueOnce(new Error('no tauri context'));
    const orphanUnsubscribe = subscribeTauriEvent('t://orphan', () => {});
    await Promise.resolve();
    await Promise.resolve();

    // 重建：另一次订阅会建立新通道。
    const rebuiltUnlisten = vi.fn();
    listen.mockResolvedValueOnce(rebuiltUnlisten);
    subscribeTauriEvent('t://orphan', () => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(subscriberCount('t://orphan')).toBe(1);

    // 孤儿退订只能影响它自己那个已脱离表的通道：既不摘掉新通道的处理器，
    // 也不解绑新通道的底层监听。
    orphanUnsubscribe();
    expect(subscriberCount('t://orphan')).toBe(1);
    expect(rebuiltUnlisten).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  describe('subscribeTauriEventReady', () => {
    it('必须等 listen() resolve 之后才 resolve —— 这是「先订阅、再触发」的保证', async () => {
      const { subscribeTauriEventReady } = await import('./tauriEvent');
      let ready = false;
      const pending = subscribeTauriEventReady<string>('t://ready', () => {}).then(
        () => {
          ready = true;
        },
      );

      await Promise.resolve();
      await Promise.resolve();
      // listen 还没 resolve：此刻绝不能认为自己已订阅就绪。
      expect(ready).toBe(false);

      resolveAllListens();
      await pending;
      expect(ready).toBe(true);
    });

    it('通道已存在时立即返回，且不再发第二条 listen()', async () => {
      const { subscribeTauriEvent, subscribeTauriEventReady } = await import(
        './tauriEvent'
      );
      subscribeTauriEvent('t://shared-ready', () => {});
      resolveAllListens();
      await Promise.resolve();
      await Promise.resolve();

      const { listen } = vi.mocked(await import('@tauri-apps/api/event'));
      expect(listen).toHaveBeenCalledTimes(1);

      let ready = false;
      const unsubscribe = await subscribeTauriEventReady<string>(
        't://shared-ready',
        () => {},
      ).then((fn) => {
        ready = true;
        return fn;
      });

      expect(ready).toBe(true);
      expect(listen).toHaveBeenCalledTimes(1);
      expect(subscriberCount('t://shared-ready')).toBe(2);
      unsubscribe();
      expect(subscriberCount('t://shared-ready')).toBe(1);
    });

    it('注册失败时也必须返回，不能把调用方永久挂住', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { subscribeTauriEventReady } = await import('./tauriEvent');
      const { listen } = vi.mocked(await import('@tauri-apps/api/event'));
      listen.mockRejectedValueOnce(new Error('no tauri context'));

      const unsubscribe = await subscribeTauriEventReady('t://ready-fail', () => {});
      expect(typeof unsubscribe).toBe('function');
      // 失败的空壳不该留下任何订阅者。
      expect(subscriberCount('t://ready-fail')).toBe(0);
      unsubscribe();
      errorSpy.mockRestore();
    });
  });
});
