import { useEffect, useRef, useState } from 'react';
import type { AgentMode } from '@/lib/types';

/**
 * 模式在「用户没碰模式按钮」的情况下变了（比如点了建议卡片里带目标模式的选项），
 * 模式按钮短暂点亮一下，让人注意到「现在换成了 X」。只看模式值的变化，不关心谁改的，
 * 所以以后别的入口改模式也自动受益。首次挂载不闪。
 */
export const MODE_PULSE_MS = 1400;

export function useModePulse(mode: AgentMode): boolean {
  const previous = useRef(mode);
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    if (previous.current === mode) return;
    previous.current = mode;
    setPulse(true);
    const timer = setTimeout(() => setPulse(false), MODE_PULSE_MS);
    return () => clearTimeout(timer);
  }, [mode]);
  return pulse;
}
