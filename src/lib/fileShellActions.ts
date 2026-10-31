/**
 * 文件管理器 →「在终端中打开」（桌面与移动端共用，唯一来源）：
 * 往同一条 SSH 会话的终端敲 `cd '<目录>'` 并回车。
 *
 * 这里只做「数据层」：怎么把终端亮出来（桌面聚焦终端、手机切底部 Tab）由各端调用方负责。
 */

import { sshSendInput } from '@/lib/tauri';

/** POSIX shell 单引号转义：`it's` → `'it'\''s'`。 */
export function shellQuote(value: string): string {
  // 用函数形式替换，免得替换串里的 `$` 序列被 String.replace 解释
  return `'${value.replace(/'/g, () => "'\\''")}'`;
}

/** 「在终端中打开」要敲进终端的整行命令（含回车）。 */
export function cdCommand(dir: string): string {
  return `cd ${shellQuote(dir)}\r`;
}

/** 往会话终端发 `cd`；失败时抛出，由调用方用 getErrorMessage 展示。 */
export async function sendCdToTerminal(sessionId: string, dir: string): Promise<void> {
  await sshSendInput(sessionId, cdCommand(dir));
}
