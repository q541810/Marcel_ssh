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
import { listen } from '@tauri-apps/api/event';

export type DropPosition = { x: number; y: number };
type DropHandler = (paths: string[], position?: DropPosition) => void;

// ─── 模块级状态：enabled handler 栈，栈顶为当前活跃处理器 ───
const handlerStack: DropHandler[] = [];
let listenersAttached = false;

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

// ─── 确保全局监听器只创建一次 ───
async function attachGlobalListeners() {
  if (listenersAttached) return;
  listenersAttached = true;

  // 文件放下
  await listen<{ paths?: string[]; position?: DropPosition }>('tauri://drag-drop', (event) => {
    setIsDragging(false);
    const paths = event.payload.paths;
    const handler = activeHandler();
    if (paths && paths.length > 0 && handler) {
      handler(paths, toCssPosition(event.payload.position));
    }
  });

  // 文件拖入窗口
  await listen('tauri://drag-enter', () => {
    if (activeHandler()) setIsDragging(true);
  });

  // 拖拽离开窗口
  await listen('tauri://drag-leave', () => {
    setIsDragging(false);
  });
}

// ─── Hook ───

export function useFileDrop(handler: DropHandler, enabled: boolean) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const [isDragging, setIsDraggingLocal] = useState(false);

  useEffect(() => {
    if (!enabled) return;

    // 透传 position，供面板判断是否落在目录树等禁 drop 区域
    const wrapper: DropHandler = (paths, position) => {
      handlerRef.current(paths, position);
    };
    handlerStack.push(wrapper);
    attachGlobalListeners();

    // 订阅拖拽状态
    const listener = (value: boolean) => setIsDraggingLocal(value);
    isDraggingListeners.add(listener);
    setIsDraggingLocal(isDraggingGlobal);

    return () => {
      isDraggingListeners.delete(listener);
      const idx = handlerStack.lastIndexOf(wrapper);
      if (idx >= 0) handlerStack.splice(idx, 1);
    };
  }, [enabled]);

  return { isDragging };
}
