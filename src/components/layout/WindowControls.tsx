import { useState, useEffect, useCallback } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import WinIcon from '@/components/ui/WinIcon';

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
        className="win-caption"
        title="最小化"
      >
        <WinIcon glyph="minimize" size={14} />
      </button>
      <button
        onClick={handleMaximize}
        className="win-caption"
        title={isMaximized ? '还原' : '最大化'}
      >
        {isMaximized ? (
          <WinIcon glyph="restore" size={13} />
        ) : (
          <WinIcon glyph="maximize" size={13} />
        )}
      </button>
      <button
        onClick={handleClose}
        className="win-caption win-caption--close"
        title="关闭"
      >
        <WinIcon glyph="close" size={14} />
      </button>
    </div>
  );
}
