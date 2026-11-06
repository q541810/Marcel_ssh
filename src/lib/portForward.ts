/**
 * 端口转发的纯逻辑（桌面底栏面板与手机 Sheet 共用）：
 * 把服务器监听表整理成“可转发的服务”，解析手动输入，拼浏览器地址。
 */
import type { RemoteSocketInfo } from './remoteSystem';
import type { PortForwardInfo } from './tauri';

export interface ListeningService {
  port: number;
  /** 转发时让服务器去连的地址：回环/通配都用 localhost，绑在具体网卡上的用那个 IP。 */
  targetHost: string;
  process: string;
}

const WILDCARD = new Set(['', '*', '0.0.0.0', '::', '[::]']);

function targetHostOf(laddr: string): string {
  const addr = laddr.split('%')[0].trim();
  if (WILDCARD.has(addr) || addr === '127.0.0.1' || addr === '::1') return 'localhost';
  return addr;
}

/** 监听中的 TCP 端口 → 去重（IPv4/IPv6 同端口只留一条）、按端口升序。 */
export function toListeningServices(sockets: RemoteSocketInfo[]): ListeningService[] {
  const byPort = new Map<number, ListeningService>();
  for (const s of sockets) {
    if (s.state.toUpperCase() !== 'LISTEN') continue;
    if (!s.proto.toLowerCase().startsWith('tcp')) continue;
    if (!(s.lport > 0 && s.lport <= 65535)) continue;
    const next: ListeningService = {
      port: s.lport,
      targetHost: targetHostOf(s.laddr),
      process: s.process && s.process !== '-' ? s.process : '',
    };
    const prev = byPort.get(s.lport);
    // 同端口多条：保留带进程名的那条
    if (!prev || (!prev.process && next.process)) byPort.set(s.lport, next);
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

export interface ParsedTarget {
  host: string;
  port: number;
}

/** 解析手动输入：`3000` 或 `10.0.0.5:3306`（后者用于转发服务器能访问到的其它机器）。 */
export function parseForwardTarget(input: string): ParsedTarget | null {
  const match = input.trim().match(/^(?:(.+):)?(\d{1,5})$/);
  if (!match) return null;
  const port = Number.parseInt(match[2], 10);
  if (!(port > 0 && port <= 65535)) return null;
  const host = (match[1] ?? 'localhost').trim().replace(/^\[(.*)\]$/, '$1');
  return host ? { host, port } : null;
}

/** 这条目标是否已转发。 */
export function findForward(
  forwards: PortForwardInfo[],
  host: string,
  port: number,
): PortForwardInfo | undefined {
  return forwards.find((f) => f.remoteHost === host && f.remotePort === port);
}

const HTTPS_PORTS = new Set([443, 8443]);

/** 浏览器打开地址：常见 HTTPS 端口走 https，其余 http。 */
export function forwardUrl(forward: Pick<PortForwardInfo, 'localPort' | 'remotePort'>): string {
  const scheme = HTTPS_PORTS.has(forward.remotePort) ? 'https' : 'http';
  return `${scheme}://127.0.0.1:${forward.localPort}`;
}

export type ForwardHealth = 'ok' | 'offline' | 'error';

export function forwardHealth(forward: PortForwardInfo): ForwardHealth {
  if (!forward.sessionOnline) return 'offline';
  return forward.lastError ? 'error' : 'ok';
}
