import { useRef } from 'react';
import type { SessionStatus } from '@/lib/types';
import './StatusDot.css';

/**
 * 连接状态点（全区唯一来源）：连接中=呼吸，已连接=绿点（刚连上时扩散一圈光晕后静止），
 * 断开=灰，错误=红。光晕只在「上一次渲染还是连接中」时出现，列表首次渲染已连接的不放。
 */
export default function StatusDot({
  status,
  className = '',
}: {
  status: SessionStatus;
  className?: string;
}) {
  const prev = useRef<SessionStatus>(status);
  const justConnected = useRef(false);
  if (prev.current !== status) {
    justConnected.current = prev.current === 'connecting' && status === 'connected';
    prev.current = status;
  }
  return (
    <span className={`status-dot ${className}`} data-status={status} aria-hidden="true">
      {status === 'connected' && justConnected.current && <span className="status-dot-ring" />}
    </span>
  );
}
