import { useRef } from 'react';
import { useTerminal } from '@/hooks/useTerminal';
import { useSessionStore } from '@/stores/sessionStore';

export default function Terminal() {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const { isReady } = useTerminal(containerRef, activeSessionId);

  return (
    <div className="relative flex-1 h-full bg-zinc-900">
      <div
        ref={containerRef}
        className="absolute inset-0 p-1 cursor-text"
      />
      {!activeSessionId && (
        <div className="absolute inset-0 flex items-center justify-center bg-zinc-900/95 z-10">
          <div className="text-center">
            <div className="text-zinc-400 text-lg mb-2">未连接</div>
            <p className="text-zinc-500 text-sm">
              从侧边栏选择一个连接或使用快速连接来启动会话。
            </p>
          </div>
        </div>
      )}
      {activeSessionId && !isReady && (
        <div className="absolute inset-0 flex items-center justify-center bg-zinc-900/90 z-10">
          <div className="text-zinc-400">正在初始化终端...</div>
        </div>
      )}
    </div>
  );
}
