import { listen } from '@tauri-apps/api/event';

/** 取消订阅。可重复调用；可在订阅尚未就绪时立即调用。 */
export type Unsubscribe = () => void;

interface EventChannel {
  /** 底层 `listen()` 的取消函数（已经过竞态保护）。 */
  unsub: Unsubscribe;
  /** 挂在同一事件名上的处理器。 */
  handlers: Set<(payload: unknown) => void>;
  /** 底层注册往返完成的信号，供 `subscribeTauriEventReady` 等待。 */
  ready: Promise<void>;
}

/**
 * 事件名 → 唯一一条底层监听 + 处理器集合。
 *
 * 同一事件被多处监听在本仓库很常见（`ssh-long-*` 桌面与移动各 4 个、
 * `plugin-install-*` 两个组件各 3 个），而每处各自 `listen()` 就各自占一条
 * 事件总线连接。改成共享一条、按处理器扇出，既少一半监听器，也让「谁订阅了」
 * 变成可枚举的状态。
 */
const channels = new Map<string, EventChannel>();

/**
 * 订阅一个 Tauri 事件，返回**同步可用**的取消订阅函数。
 *
 * 这个原语存在的唯一理由是 `listen()` 是异步的，而这件事在本仓库已经反复造成
 * 三类别扭的 bug：
 *
 * 1. **卸载早于 Promise resolve → 监听器泄漏**。组件卸载或 detach 时 unlisten
 *    还没拿到，`unlisteners.forEach(...)` 遍历的是空数组，监听器永远留在事件
 *    总线上。这里用 `disposed` 标志兜住：resolve 时若已取消，立刻 unlisten。
 *
 * 2. **StrictMode 双挂载 → 重复注册**。React 18 开发模式下组件会
 *    mount → cleanup → mount。若幂等守卫写成「await 之后再置位的布尔量」，
 *    两次并发注册都能通过守卫，监听器数量翻倍（`sftpTransferManager` 就这样
 *    漏了 8 条）。本函数的返回值是**同步**产生的，守卫在调用处就同步生效。
 *
 * 3. **调用方拿到未就绪的 unlisten**。延迟清理的地方都得自己存一个
 *    `let unlisten: UnlistenFn | null`，漏一处泄漏一处。这里把它收进闭包。
 *
 * 未改变的语义：事件到达的相对顺序、payload 形状，以及「取消后不再收到回调」。
 *
 * **`handler` 必须每次调用都新建**（通常是内联箭头函数）：处理器按函数引用去重，
 * 把同一个函数引用订阅两次时第二次静默无效，而第一次取消会同时摘掉这两次订阅。
 */
export function subscribeTauriEvent<T>(
  eventName: string,
  handler: (payload: T) => void,
): Unsubscribe {
  const typed = handler as (payload: unknown) => void;
  let channel = channels.get(eventName);

  if (!channel) {
    const handlers = new Set<(payload: unknown) => void>();
    let unlisten: Unsubscribe | null = null;
    let disposed = false;
    let markReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });

    /** 当前这个通道对象；失败时用来把自己从表里摘掉。 */
    const self: EventChannel = {
      unsub: () => {
        disposed = true;
        unlisten?.();
        unlisten = null;
      },
      handlers,
      ready,
    };

    void listen<unknown>(eventName, (event) => {
      // 复制一份再遍历：处理器可能在回调里取消自己（如「收到终态事件就退订」）。
      for (const fn of [...handlers]) {
        try {
          fn(event.payload);
        } catch (err) {
          // 单个处理器抛错不应中断其余处理器，也不应冒泡到事件总线。
          console.error(`事件 ${eventName} 的处理器抛错:`, err);
        }
      }
    })
      .then((fn) => {
        markReady();
        if (disposed) {
          // 订阅比取消晚到：立刻回收，否则监听器会一直挂在事件总线上。
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch((err) => {
        // 注册失败也要放行等待者，否则调用方会永久挂起。
        markReady();
        // 把失败的空壳从表里摘掉，让后面对同一事件名的订阅重建一次。
        // 留着它的话，这个通道没有底层监听却会被后来者复用，谁都收不到事件。
        //
        // 注意「重建」的前提是**确实有人再订阅**：像 `sftpTransferManager`
        // 那样的模块级单例只会 attach 一次，所以它那条事件在本次进程内就一直是
        // 死的（直到重启）。这与改造前一致（旧的 `listen` 失败同样是静默无事件），
        // 只是不再抛出一条未捕获异常。
        if (channels.get(eventName) === self) channels.delete(eventName);
        console.error(`订阅事件 ${eventName} 失败:`, err);
      });

    channel = self;
    channels.set(eventName, channel);
  }

  const current = channel;
  if (current.handlers.has(typed)) {
    // 同一个函数引用被订阅两次：`Set` 会静默吞掉第二次，而第一次退订会同时摘掉
    // 这两次订阅。所有调用点都传内联箭头函数（每次调用都是新引用），所以走到这里
    // 说明有人把处理器提升成了模块级常量 —— 那是个 bug，不是优化。
    console.warn(
      `事件 ${eventName} 的同一个处理器被订阅了两次：处理器必须每次调用新建`,
    );
  }
  current.handlers.add(typed);

  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    current.handlers.delete(typed);
    // 最后一个处理器离开时才真正解绑，避免「A 取消把 B 的监听也带走」。
    if (current.handlers.size === 0 && channels.get(eventName) === current) {
      channels.delete(eventName);
      current.unsub();
    }
  };
}

/**
 * 同 [`subscribeTauriEvent`]，但**等底层注册往返完成后**才返回。
 *
 * 用于有「先订阅、再触发」顺序契约的地方：后端在命令返回后立刻发出的事件不能被
 * 漏掉，所以必须等注册完成，才能发起那个会引发事件的动作。当前真正的用户是
 * `PluginSection` 的更新流程（先挂监听再开始更新），它原来靠 `await listen(...)`
 * 保证顺序；用本函数就同时拿到「顺序保证」与「同步可用的取消函数」。
 *
 * `updateStore.init` 也是同一个形状（先订阅 `update://state` 再拉快照），但**刻意
 * 没有迁过来**：它是进程级单例、终生不退订，且有自己的失败重试语义（`listen` 失败
 * 时把 `initPromise` 置回 null 让下次挂载重试），而本函数在注册失败时同样会 resolve
 * —— 换过来反而丢掉那条重试路径。
 *
 * 注意契约是「注册往返已结束」而**不是**「订阅成功」：`listen` 失败时也会返回
 * （内部已记日志），调用方照常往下走 —— 与改造前各站点各自 `listen` 失败的行为
 * 一致。失败的空壳不会留在通道表里，下次订阅会重建。
 */
export async function subscribeTauriEventReady<T>(
  eventName: string,
  handler: (payload: T) => void,
): Promise<Unsubscribe> {
  const unsubscribe = subscribeTauriEvent<T>(eventName, handler);
  await (channels.get(eventName)?.ready ?? Promise.resolve());
  return unsubscribe;
}

/**
 * 当前有多少个处理器挂在某个事件上。仅供测试与诊断使用 ——
 * 用来断言「卸载后没有残留订阅」这类此前无法观测的泄漏。
 */
export function subscriberCount(eventName: string): number {
  return channels.get(eventName)?.handlers.size ?? 0;
}

/** 清空所有订阅。仅测试用（模拟整棵应用树卸载）。 */
export function resetEventChannelsForTest(): void {
  for (const channel of channels.values()) channel.unsub();
  channels.clear();
}
