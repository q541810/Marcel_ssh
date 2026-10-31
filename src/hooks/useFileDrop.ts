/**
 * useFileDrop — 通用文件拖拽 hook
 *
 * Tauri v2 的文件拖拽事件（注意：不是 HTML5 drag-and-drop，Tauri 原生拦截了拖拽）：
 *   - tauri://drag-enter  — 文件拖入窗口，payload: { paths: string[], position: {x, y} }
 *   - tauri://drag-over   — 文件悬停，payload: { position: {x, y} }（paths 为 null）
 *   - tauri://drag-drop   — 文件放下，payload: { paths: string[], position: {x, y} }
 *   - tauri://drag-leave  — 拖拽离开，payload: {}
 *
 * 使用方式：
 *   useFileDrop((paths) => { ... }, enabled)
 *
 * 模块级 handler 栈：后注册的在栈顶优先处理（如 SkillCreateModal 打开时覆盖 SFTP）。
 * unmount / enabled=false 时 pop 自己，栈顶交还给仍 enabled 的前一个消费者。
 */

import { useEffect, useRef, useState } from 'react';
import { subscribeTauriEvent, type Unsubscribe } from '@/lib/tauriEvent';

export type DropPosition = { x: number; y: number };
type DropHandler = (paths: string[], position?: DropPosition) => void;

// ─── 模块级状态：enabled handler 栈，栈顶为当前活跃处理器 ───
const handlerStack: DropHandler[] = [];

function activeHandler(): DropHandler | null {
  return handlerStack.length > 0 ? handlerStack[handlerStack.length - 1]! : null;
}

// ─── 模块级拖拽状态（用于外部订阅） ───
let isDraggingGlobal = false;
const isDraggingListeners = new Set<(value: boolean) => void>();

function setIsDragging(value: boolean) {
  isDraggingGlobal = value;
  for (const fn of isDraggingListeners) fn(value);
}

/** Tauri drag-drop 的 position 是物理像素，DOM 用 CSS 像素；统一成 CSS 坐标 */
function toCssPosition(position?: DropPosition): DropPosition | undefined {
  if (!position) return undefined;
  const dpr =
    typeof window !== 'undefined' && window.devicePixelRatio > 0
      ? window.devicePixelRatio
      : 1;
  if (dpr === 1) return position;
  return { x: position.x / dpr, y: position.y / dpr };
}

/** 统一的 drop 入口：只有栈顶消费者处理，其余实例不动。 */
function handleDrop(paths: string[] | undefined, position?: DropPosition) {
  setIsDragging(false);
  const handler = activeHandler();
  if (paths && paths.length > 0 && handler) {
    handler(paths, toCssPosition(position));
  }
}

// ─── Hook ───

/**
 * @param onHover 拖拽途中指针位置（CSS 像素）；拖拽结束/离开时给 null。
 *   只有当前活跃（栈顶）的消费者收到，用来在落点上做高亮（如目录树的目录行）。
 */
export function useFileDrop(
  handler: DropHandler,
  enabled: boolean,
  onHover?: (position: DropPosition | null) => void,
) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const hoverRef = useRef(onHover);
  hoverRef.current = onHover;

  const [isDragging, setIsDraggingLocal] = useState(false);

  useEffect(() => {
    if (!enabled) return;

    // 透传 position，供面板判断是否落在目录树等禁 drop 区域
    const wrapper: DropHandler = (paths, position) => {
      handlerRef.current(paths, position);
    };
    handlerStack.push(wrapper);
    const emitHover = (position: DropPosition | null) => {
      if (activeHandler() !== wrapper) return;
      hoverRef.current?.(position ? (toCssPosition(position) ?? null) : null);
    };

    // 用事件订阅原语而非裸 listen：旧实现把 `listenersAttached = true` 写在
    // `await listen` **之前**且不接错误，任何一次注册失败都会留下未捕获 rejection，
    // 并让本进程内的拖拽上传**永久失效**（守卫再也放不开）。
    // subscribeTauriEvent 同步返回取消函数、注册失败只记日志并摘掉空壳通道；
    // 失败后只要有新的挂载（或本实例重挂），同一事件名会重新注册，即可重试。
    const offs: Unsubscribe[] = [
      subscribeTauriEvent<{ paths?: string[]; position?: DropPosition }>(
        'tauri://drag-drop',
        (payload) => handleDrop(payload.paths, payload.position),
      ),
      subscribeTauriEvent<{ position?: DropPosition }>('tauri://drag-enter', (payload) => {
        if (activeHandler()) setIsDragging(true);
        emitHover(payload?.position ?? null);
      }),
      subscribeTauriEvent<{ position?: DropPosition }>('tauri://drag-over', (payload) => {
        emitHover(payload?.position ?? null);
      }),
      subscribeTauriEvent('tauri://drag-leave', () => {
        setIsDragging(false);
        emitHover(null);
      }),
    ];

    // 订阅拖拽状态
    const listener = (value: boolean) => setIsDraggingLocal(value);
    isDraggingListeners.add(listener);
    setIsDraggingLocal(isDraggingGlobal);

    return () => {
      for (const off of offs) off();
      isDraggingListeners.delete(listener);
      const idx = handlerStack.lastIndexOf(wrapper);
      if (idx >= 0) handlerStack.splice(idx, 1);
    };
  }, [enabled]);

  return { isDragging };
}
