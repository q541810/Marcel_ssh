/**
 * contextWindow（模型上下文窗口，tokens）的非阻塞提示文案。
 *
 * 设计：**无硬上限**——未来超大窗口模型（如 1B tokens）必须能配置，
 * 任何数值都允许保存（`pressure_eligible` 对任意 u64 不溢出）。仅对
 * 异常区间给灰字提示（不阻止保存），避免笔误导致"预防式压缩静默失效"
 * 而用户毫无感知：
 * - `> 10_000_000`：预防式压缩可能极少触发；
 * - `(0, 150_000)`：可能频繁误触发。
 * 桌面（ValidatedInput hint）与移动端共用此函数，保证文案一致。
 */
export function contextWindowHint(window: number | undefined): string | undefined {
  const v = window ?? 0;
  if (v > 10_000_000) {
    return '该值大于常见模型窗口，预防式压缩可能极少触发；如非笔误可忽略。';
  }
  if (v > 0 && v < 150_000) {
    return '该值过小，可能经常误触发压缩，推荐您使用0，在模型超限时自动触发';
  }
  return undefined;
}
