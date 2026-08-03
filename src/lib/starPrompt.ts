/** Star 弹窗触发控制：每周最多一次、可永久忽略、启动计数每 N 次尝试一次。
 *  纯函数 + localStorage（与 marketStore 同款 try/catch 模式），桌面/移动端共享。 */

const IGNORED_KEY = 'marcel.starPrompt.ignored';
const LAST_SHOWN_KEY = 'marcel.starPrompt.lastShown';
const LAUNCH_COUNT_KEY = 'marcel.starPrompt.launchCount';

/** 启动计数达到该次数后尝试弹一次（配合每周限频）。统一 5 次（桌面/移动端一致）。 */
const LAUNCH_THRESHOLD = 5;
/** 两次弹窗的最小间隔（毫秒）：一周。 */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** 读取 localStorage；返回 undefined 表示存储不可用（异常），null 表示无值。 */
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
    // localStorage 不可用时仅本次会话有效，不影响主流程
  }
}

/** 已永久忽略（点了 Star / 不再提醒）。 */
function isIgnored(): boolean {
  return read(IGNORED_KEY) === '1';
}

/** 距上次弹窗是否仍在冷却期内（一周内不重复弹）。 */
function withinCooldown(): boolean {
  const last = Number(read(LAST_SHOWN_KEY) ?? 0);
  if (!Number.isFinite(last) || last <= 0) return false;
  return Date.now() - last < WEEK_MS;
}

/** 记录本次弹窗时间。 */
function markShown(): void {
  write(LAST_SHOWN_KEY, String(Date.now()));
}

/** 核心判定：未忽略 && 不在冷却期 → 标记本次弹窗并放行。
 *  存储不可用（读不到任何值）时保持保守：不弹，避免每次触发都重复出现。 */
function shouldShowNow(): boolean {
  if (isIgnored()) return false;
  if (withinCooldown()) return false;
  if (read(LAST_SHOWN_KEY) === undefined) return false;
  markShown();
  return true;
}

/** 安装成功后的触发点（市场页「一键安装」成功时调用）。 */
export function maybeShowStarPromptOnInstall(): boolean {
  return shouldShowNow();
}

/** 启动触发点：每 LAUNCH_THRESHOLD 次启动尝试一次；尝试后计数归零，
 *  是否真正弹出仍受「未忽略 + 每周一次」约束。 */
export function maybeShowStarPromptOnLaunch(): boolean {
  const count = Number(read(LAUNCH_COUNT_KEY) ?? 0);
  const next = (Number.isFinite(count) ? count : 0) + 1;
  if (next < LAUNCH_THRESHOLD) {
    write(LAUNCH_COUNT_KEY, String(next));
    return false;
  }
  write(LAUNCH_COUNT_KEY, '0');
  return shouldShowNow();
}

/** 永久忽略（点了「去 Star」或「不再提醒」）。 */
export function dismissStarPrompt(): void {
  write(IGNORED_KEY, '1');
}
