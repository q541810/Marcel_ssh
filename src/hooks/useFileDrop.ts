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
 * 模块级 activeHandler 确保同一时间只有一个组件处理拖拽。
 * 后注册的覆盖先注册的（SkillCreateModal 打开时覆盖 SFTP 面板）。
 */

import { useEffect, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

type DropHandler = (paths: string[]) => void;

// ─── 模块级状态：全局只有一个活跃处理器 ───
let activeHandler: DropHandler | null = null;
let listenersAttached = false;
let refCount = 0;

// ─── 模块级拖拽状态（用于外部订阅） ───
let isDraggingGlobal = false;
const isDraggingListeners = new Set<(value: boolean) => void>();

function setIsDragging(value: boolean) {
  isDraggingGlobal = value;
  for (const fn of isDraggingListeners) fn(value);
}

// ─── 确保全局监听器只创建一次 ───
async function attachGlobalListeners() {
  if (listenersAttached) return;
  listenersAttached = true;

  // 文件放下
  await listen<{ paths?: string[] }>('tauri://drag-drop', (event) => {
    setIsDragging(false);
    const paths = event.payload.paths;
    if (paths && paths.length > 0 && activeHandler) {
      activeHandler(paths);
    }
  });

  // 文件拖入窗口
  await listen('tauri://drag-enter', () => {
    if (activeHandler) setIsDragging(true);
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

    // 注册当前 handler 为活跃处理器
    activeHandler = (paths) => handlerRef.current(paths);
    refCount++;
    attachGlobalListeners();

    // 订阅拖拽状态
    const listener = (value: boolean) => setIsDraggingLocal(value);
    isDraggingListeners.add(listener);
    setIsDraggingLocal(isDraggingGlobal);

    return () => {
      refCount--;
      isDraggingListeners.delete(listener);
      // 只有当自己是活跃处理器时才清除
      if (activeHandler === handlerRef.current) {
        activeHandler = null;
      }
    };
  }, [enabled]);

  return { isDragging };
}
