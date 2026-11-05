import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { OPEN_BOTTOM_TAB_EVENT, registerBottomPanelHost } from '@/lib/bottomPanelNav';

const PANEL_RATIO_KEY = 'marcel:panelHeightRatio';
const ACTIVE_TAB_KEY = 'marcel:terminalActiveTab';
const MIN_PANEL_HEIGHT = 100;
const MAX_PANEL_HEIGHT = 500;
const RESIZE_SETTLE_MS = 120;
const COLLAPSE_UNMOUNT_MS = 200;

function clampPanelHeight(value: number): number {
  return Math.min(MAX_PANEL_HEIGHT, Math.max(MIN_PANEL_HEIGHT, value));
}

export function useTerminalBottomPanel() {
  const terminalRootRef = useRef<HTMLDivElement>(null);
  const panelRatioRef = useRef(0);
  const panelResizeStartRef = useRef<{ y: number; height: number } | null>(null);
  // 拖拽手势真正改动过高度、且尚未落库的脏标记。窗口 resize 触发的比例重算
  // 只动本地 state/localStorage，不置脏——否则用户拖过一次后，每次 resize
  // 都会整份序列化写盘（读路径本来就优先 localStorage 的比例值）。
  const panelHeightDirtyRef = useRef(false);
  const terminalRootHeightRef = useRef(0);
  const terminalRootHeightReadyRef = useRef(false);
  const terminalRootResizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ratioInitDoneRef = useRef(false);

  const storePanelHeight = useSettingsStore((s) => s.settings.panelHeight);
  const settingsLoaded = useSettingsStore((s) => s.loaded);

  const [activeTab, setActiveTabRaw] = useState<string | null>(() => {
    try {
      return localStorage.getItem(ACTIVE_TAB_KEY);
    } catch {
      return null;
    }
  });
  const [displayTab, setDisplayTab] = useState<string | null>(null);
  const [isResizingPanel, setIsResizingPanel] = useState(false);
  const [containerHeight, setContainerHeight] = useState(0);
  const [panelHeight, setPanelHeight] = useState(storePanelHeight ?? 256);

  const setActiveTab = useCallback((tab: string | null) => {
    setActiveTabRaw(tab);
    try {
      if (tab) {
        localStorage.setItem(ACTIVE_TAB_KEY, tab);
      } else {
        localStorage.removeItem(ACTIVE_TAB_KEY);
      }
    } catch {
      // localStorage can be unavailable in restricted WebView contexts.
    }
  }, []);

  // 别处（agent 的文件链接「在文件管理中显示」等）请求切到某个底栏标签：收着就展开。
  // 只「设为」不「切换」——请求的标签已经开着时什么都不做，不会把它收起来。
  // 展开 / 收起的过渡与终端行数协调由 Terminal.tsx 盯着 activeTab 自己接，这里不用管。
  useEffect(() => {
    const unregister = registerBottomPanelHost();
    const onOpenTab = (event: Event) => {
      const tab = (event as CustomEvent<{ tab?: unknown }>).detail?.tab;
      if (typeof tab === 'string' && tab) setActiveTab(tab);
    };
    window.addEventListener(OPEN_BOTTOM_TAB_EVENT, onOpenTab);
    return () => {
      window.removeEventListener(OPEN_BOTTOM_TAB_EVENT, onOpenTab);
      unregister();
    };
  }, [setActiveTab]);

  const savePanelRatio = useCallback((ratio: number) => {
    panelRatioRef.current = ratio;
    try {
      localStorage.setItem(PANEL_RATIO_KEY, String(ratio));
    } catch {
      // localStorage can be unavailable in restricted WebView contexts.
    }
  }, []);

  useEffect(() => {
    try {
      const v = localStorage.getItem(PANEL_RATIO_KEY);
      if (v) panelRatioRef.current = parseFloat(v) || 0;
    } catch {
      // Keep the terminal usable even if localStorage is unavailable.
    }
  }, []);

  useEffect(() => {
    const el = terminalRootRef.current;
    if (!el) return;

    const ro = new ResizeObserver(([entry]) => {
      const height = Math.round(entry.contentRect.height);
      if (terminalRootHeightRef.current === height) return;
      terminalRootHeightRef.current = height;

      if (!terminalRootHeightReadyRef.current) {
        terminalRootHeightReadyRef.current = true;
        setContainerHeight(height);
        return;
      }

      if (terminalRootResizeTimeoutRef.current) clearTimeout(terminalRootResizeTimeoutRef.current);
      terminalRootResizeTimeoutRef.current = setTimeout(() => {
        setContainerHeight(terminalRootHeightRef.current);
      }, RESIZE_SETTLE_MS);
    });

    ro.observe(el);
    return () => {
      ro.disconnect();
      if (terminalRootResizeTimeoutRef.current) clearTimeout(terminalRootResizeTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (containerHeight <= 0 || !settingsLoaded || ratioInitDoneRef.current) return;
    ratioInitDoneRef.current = true;

    if (panelRatioRef.current > 0) {
      setPanelHeight(clampPanelHeight(Math.round(panelRatioRef.current * containerHeight)));
    } else {
      const storePx = storePanelHeight ?? 256;
      panelRatioRef.current = storePx / containerHeight;
      savePanelRatio(panelRatioRef.current);
      setPanelHeight(storePx);
    }
  }, [containerHeight, settingsLoaded, storePanelHeight, savePanelRatio]);

  useEffect(() => {
    if (containerHeight <= 0 || !ratioInitDoneRef.current) return;
    setPanelHeight(clampPanelHeight(Math.round(panelRatioRef.current * containerHeight)));
  }, [containerHeight]);

  const handlePanelResizeMouseDown = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    panelResizeStartRef.current = { y: e.clientY, height: panelHeight };
    setIsResizingPanel(true);
  }, [panelHeight]);

  useEffect(() => {
    if (!isResizingPanel) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!panelResizeStartRef.current) return;
      const delta = panelResizeStartRef.current.y - e.clientY;
      const newHeight = clampPanelHeight(panelResizeStartRef.current.height + delta);
      panelHeightDirtyRef.current = true;
      setPanelHeight(newHeight);
      if (containerHeight > 0) {
        savePanelRatio(newHeight / containerHeight);
      }
    };

    const handleMouseUp = () => {
      setIsResizingPanel(false);
      panelResizeStartRef.current = null;
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizingPanel, containerHeight, savePanelRatio]);

  // 拖拽手势结束才把最终高度落库；resize 引发的重算不置脏，不会走到这里。
  useEffect(() => {
    if (!settingsLoaded) return;
    if (!isResizingPanel && panelResizeStartRef.current === null && panelHeightDirtyRef.current) {
      panelHeightDirtyRef.current = false;
      useSettingsStore.getState().update({ panelHeight });
    }
  }, [isResizingPanel, panelHeight]);

  useEffect(() => {
    if (activeTab) {
      setDisplayTab(activeTab);
    } else {
      const timer = setTimeout(() => setDisplayTab(null), COLLAPSE_UNMOUNT_MS);
      return () => clearTimeout(timer);
    }
  }, [activeTab]);

  return {
    terminalRootRef,
    activeTab,
    setActiveTab,
    displayTab,
    isResizingPanel,
    panelHeight,
    handlePanelResizeMouseDown,
  };
}
