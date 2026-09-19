import { useEffect, useRef } from 'react';
import { subscribeTauriEvent } from '@/lib/tauriEvent';

/**
 * 声明式订阅一个 Tauri 事件：挂载即订阅、卸载即退订。
 *
 * - `eventName` 传 `null` / `undefined` 时订阅被挂起（例如「当前没有选中的
 *   会话，自然没有 `ssh://output/<id>` 可听」），避免调用方在外面写条件分支。
 * - `handler` 不必 memo：它存在 ref 里，只有换事件名才会重新订阅。这样调用方
 *   每次渲染传新箭头函数也不会造成「退了又订」的抖动。
 * - 事件名可以带变量（`agent://stream/${taskId}`），变化时自动切订阅。
 *
 * 竞态与泄漏的处理都在 `subscribeTauriEvent` 里，包括「卸载早于 Promise
 * resolve」与 StrictMode 双挂载。
 */
export function useTauriEvent<T>(
  eventName: string | null | undefined,
  handler: (payload: T) => void,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!eventName) return;
    return subscribeTauriEvent<T>(eventName, (payload) => handlerRef.current(payload));
  }, [eventName]);
}
