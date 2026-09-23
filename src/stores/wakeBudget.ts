/**
 * 自动继续的额度（每个会话一份）。
 *
 * 对齐 DSH 的 `maxConsecutiveWakes`：作业跑完自动开一轮这件事是**自激励**的
 * —— 被叫醒的那一轮可能又派一条作业，作业跑完又把它叫醒，如此往复。3 次
 * 封顶就是掐断这条链的闸门。
 *
 * **只有真正的用户输入回填额度**（用户在那个会话里发一句话 = 新一轮人为
 * 驱动的工作）。系统自己写的结算告知**不算**：DSH 的注释说得直白 —— 插件
 * 自己排的通知不许解封它刚花掉的额度，否则上限会被自己的通知一次次解封，
 * 等于没有上限。
 *
 * 独立成模块（不 import 任何 store）：taskStore 要在用户发消息时回填、
 * `jobWake` 要花额度，两边都引它，放在任一 store 里都会绕出循环依赖。
 */

/** 用户每发一句话之后，最多自动继续几轮（对齐 DSH 默认值 3）。 */
export const MAX_AUTO_CONTINUES = 3;

const spent = new Map<string, number>();

/** 已花掉的自动继续次数。 */
export function autoContinuesSpent(conversationId: string): number {
  return spent.get(conversationId) ?? 0;
}

/** 还有没有额度（没有就**不唤醒**：结算告知留着，等用户下次开口时交给模型）。 */
export function canAutoContinue(conversationId: string): boolean {
  return autoContinuesSpent(conversationId) < MAX_AUTO_CONTINUES;
}

/** 花掉一次（**开轮成功之后**才调：开失败没花用户的钱，不该占额度）。 */
export function spendAutoContinue(conversationId: string): void {
  spent.set(conversationId, autoContinuesSpent(conversationId) + 1);
}

/** 用户真的说了句话 → 额度回满。 */
export function resetAutoContinues(conversationId: string): void {
  spent.delete(conversationId);
}

/** 测试用：清空全部额度。 */
export function __resetAllAutoContinues(): void {
  spent.clear();
}
