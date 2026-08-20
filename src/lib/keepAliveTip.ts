/** 后台保活提示卡片的持久化控制（移动端连接列表底部）。
 *  仿 starPrompt.ts 的 try/catch 模式，localStorage 不可用时静默降级。 */

const DISMISSED_KEY = 'marcel.keepAliveTip.dismissed';

function read(key: string): string | null | undefined {
  try {
    return localStorage.getItem(key);
  } catch {
    return undefined;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage 不可用时仅本次会话有效
  }
}

/** 是否已点过"不再显示"（永久忽略）。 */
export function isKeepAliveTipDismissed(): boolean {
  return read(DISMISSED_KEY) === '1';
}

/** 永久忽略：写入标记，之后不再显示。 */
export function dismissKeepAliveTipPermanently(): void {
  write(DISMISSED_KEY, '1');
}

/** 清除永久忽略标记（用于设置页重置或测试）。 */
export function clearKeepAliveTipDismissed(): void {
  try {
    localStorage.removeItem(DISMISSED_KEY);
  } catch {
    /* ignore */
  }
}
