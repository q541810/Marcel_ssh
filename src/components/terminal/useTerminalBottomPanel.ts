import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';

const PANEL_RATIO_KEY = 'marcel:panelHeightRatio';
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
  const hasResizedRef = useRef(false);
  const terminalRootHeightRef = useRef(0);
  const terminalRootHeightReadyRef = useRef(false);
  const terminalRootResizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ratioInitDoneRef = useRef(false);

  const storePanelHeight = useSettingsStore((s) => s.settings.panelHeight);
  const settingsLoaded = useSettingsStore((s) => s.loaded);

  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [displayTab, setDisplayTab] = useState<string | null>(null);
  const [isResizingPanel, setIsResizingPanel] = useState(false);
  const [containerHeight, setContainerHeight] = useState(0);
  const [panelHeight, setPanelHeight] = useState(storePanelHeight ?? 256);

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
    hasResizedRef.current = true;
  }, [panelHeight]);

  useEffect(() => {
    if (!isResizingPanel) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!panelResizeStartRef.current) return;
      const delta = panelResizeStartRef.current.y - e.clientY;
      const newHeight = clampPanelHeight(panelResizeStartRef.current.height + delta);
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

  useEffect(() => {
    if (!isResizingPanel && panelResizeStartRef.current === null && hasResizedRef.current) {
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
