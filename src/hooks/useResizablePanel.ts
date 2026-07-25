import { useState, useCallback, useEffect, useRef } from 'react';

interface UseResizablePanelOptions {
  initialWidth: number;
  minWidth: number;
  maxWidth: number;
  onChange?: (width: number) => void;
  /**
   * Which side the panel sits on relative to the drag handle.
   * - `right` (default): handle on panel's left edge; drag left → wider (agent/sidebar style)
   * - `left`: handle on panel's right edge; drag right → wider (file tree)
   */
  edge?: 'left' | 'right';
}

export function useResizablePanel({
  initialWidth,
  minWidth,
  maxWidth,
  onChange,
  edge = 'right',
}: UseResizablePanelOptions) {
  const [width, setWidth] = useState(initialWidth);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartRef = useRef<{ x: number; width: number } | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const edgeRef = useRef(edge);
  edgeRef.current = edge;

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizeStartRef.current = { x: e.clientX, width };
    setIsResizing(true);
  }, [width]);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!resizeStartRef.current) return;
      const raw =
        edgeRef.current === 'left'
          ? e.clientX - resizeStartRef.current.x
          : resizeStartRef.current.x - e.clientX;
      const newWidth = Math.min(maxWidth, Math.max(minWidth, resizeStartRef.current.width + raw));
      setWidth(newWidth);
      onChangeRef.current?.(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      resizeStartRef.current = null;
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing, minWidth, maxWidth]);

  return { width, isResizing, startResize, setWidth };
}
