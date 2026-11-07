import { useState, useEffect, useCallback } from 'react';
import { Minus, Square, Copy, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';

export default function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);

  const checkMaximized = useCallback(async () => {
    try {
      setIsMaximized(await getCurrentWindow().isMaximized());
    } catch (e) {
      console.error('Failed to check maximized state:', e);
    }
  }, []);

  useEffect(() => {
    checkMaximized();
  }, [checkMaximized]);

  const handleMinimize = () => {
    getCurrentWindow().minimize();
  };

  const handleMaximize = async () => {
    try {
      await getCurrentWindow().toggleMaximize();
      await checkMaximized();
    } catch (e) {
      console.error('Failed to toggle maximized state:', e);
    }
  };

  const handleClose = () => {
    getCurrentWindow().close();
  };

  return (
    <div className="flex items-center">
      <button
        onClick={handleMinimize}
        className="w-11 h-8 flex items-center justify-center text-fg-secondary hover:text-fg hover:bg-state-soft transition-colors duration-120 focus-ring"
        title="最小化"
      >
        <Minus size={16} strokeWidth={1.5} />
      </button>
      <button
        onClick={handleMaximize}
        className="w-11 h-8 flex items-center justify-center text-fg-secondary hover:text-fg hover:bg-state-soft transition-colors duration-120 focus-ring"
        title={isMaximized ? '还原' : '最大化'}
      >
        {isMaximized ? (
          <Copy size={14} strokeWidth={1.5} />
        ) : (
          <Square size={14} strokeWidth={1.5} />
        )}
      </button>
      <button
        onClick={handleClose}
        className="w-11 h-8 flex items-center justify-center text-fg-secondary hover:text-white hover:bg-red-500 transition-colors duration-120 focus-ring"
        title="关闭"
      >
        <X size={16} strokeWidth={1.5} />
      </button>
    </div>
  );
}
