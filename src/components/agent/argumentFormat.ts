/**
 * 确认界面（ApprovalDialog）参数格式化辅助。
 *
 * 现状问题：确认界面把整个 tool arguments JSON 塞进横向滚动的 `<pre>`，
 * 长命令（execute_command）体验差；且 JSON 里混着后端根本不读取的字段
 * （如 `execute_command` 的 `timeout_secs`——后端超时来自用户设置的
 * `command_timeout_secs`，见 `execute_cmd.rs`），展示出来是噪音。
 *
 * 这里的策略是「只踢确定没用的部分」：
 * 1. 提取核心字段（execute_command 的 `command`）作为主展示，自动换行；
 * 2. 剔除确定无用字段（后端 schema 不声明、且 execute 不读取的字段）；
 * 3. 剔除无信息量值（null / 空字符串 / 空数组 / 空对象）。
 * 其余字段原样保留，保证不丢信息。
 */

/** execute_command 中后端确定不读取、展示无意义的字段。 */
const EXECUTE_COMMAND_USELESS_FIELDS: ReadonlySet<string> = new Set([
  // execute_cmd.rs 的 execute() 只读取 command；超时来自 policy 的
  // command_timeout_secs，模型传入的 timeout_secs 从不被读取。
  'timeout_secs',
]);

/** 判断一个值是否无信息量：null / 空字符串 / 空数组 / 空对象。 */
export function isUselessValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

export interface CleanedArguments {
  /** 主展示字段值（如 execute_command 的 command）。 */
  main?: string;
  /** 剔除无用字段后仍需展示的其余参数。 */
  extras: Record<string, unknown>;
}

/**
 * 清理 execute_command 参数：提取 command 作为主展示，剔除确定无用字段
 * （timeout_secs）与无信息量值，其余字段原样保留。
 */
export function cleanExecuteCommandArgs(
  args: Record<string, unknown> | undefined,
): CleanedArguments {
  if (!args) return { extras: {} };

  const main =
    typeof args.command === 'string' && args.command.trim() !== ''
      ? args.command
      : undefined;

  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === 'command') continue;
    if (EXECUTE_COMMAND_USELESS_FIELDS.has(key)) continue;
    if (isUselessValue(value)) continue;
    extras[key] = value;
  }
  return { main, extras };
}
