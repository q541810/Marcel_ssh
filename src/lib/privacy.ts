/**
 * 隐私模式（Privacy Mode）工具。
 *
 * 开启时，所有显示 SSH 主机 / 端口的 UI（连接列表、快速连接、HostKey 提示、
 * 对话历史、会话描述等）都通过这里集中处理，**只脱敏屏幕显示**——底层
 * 连接和持久化仍然使用真实值，不影响功能。
 *
 * 脱敏格式有意做得不留任何信息痕迹：
 * - host → `***`（不论是 IP 还是域名）
 * - port → `****`
 * 这样旁观者既看不出 IP 段，也猜不出常用端口。
 */

export const MASKED_HOST = '***';
export const MASKED_PORT = '****';

export function maskHost(_host: string, privacyMode: boolean): string {
  return privacyMode ? MASKED_HOST : _host;
}

export function maskPort(_port: number, privacyMode: boolean): number | string {
  return privacyMode ? MASKED_PORT : _port;
}

/** `host[:port]` 形式。port 为 null 时只显示 host。 */
export function formatAddress(
  host: string,
  port: number | null,
  privacyMode: boolean,
): string {
  if (privacyMode) {
    return port == null ? MASKED_HOST : `${MASKED_HOST}:${MASKED_PORT}`;
  }
  return port == null ? host : `${host}:${port}`;
}

/** `user@host:port` 形式。username 不脱敏（用户区分自己多台机器的标识）。 */
export function formatConnLabel(
  username: string,
  host: string,
  port: number,
  privacyMode: boolean,
): string {
  if (privacyMode) {
    return `${username}@${MASKED_HOST}:${MASKED_PORT}`;
  }
  return `${username}@${host}:${port}`;
}

/** `name (host:port)` 形式，用于历史/列表副标题。name 保留。 */
export function formatNameWithAddress(
  name: string,
  host: string,
  port: number,
  privacyMode: boolean,
): string {
  return `${name} (${formatAddress(host, port, privacyMode)})`;
}
