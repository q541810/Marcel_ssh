/**
 * 端口转发的纯逻辑（桌面底栏面板与手机 Sheet 共用）：
 * 把服务器监听表整理成“可转发的服务”，解析手动输入，拼浏览器地址。
 */
import type { RemoteSocketInfo } from './remoteSystem';
import type { PortForwardNote } from './types';
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

/** 一行转发/目标的展示数据：活转发、记住的备注/置顶、扫描到的服务按目标地址合并成同一份列表。 */
export interface ForwardRow {
  /** 行身份 = 目标地址 `host|port`，与后端备注记录的键一致。 */
  key: string;
  remoteHost: string;
  remotePort: number;
  /** 当前正在转发；没有 = 未转发的目标（服务在跑，或只是被记住）。 */
  forward?: PortForwardInfo;
  note: string;
  pinned: boolean;
  /**
   * 服务器扫描结果里是否有这个目标。**只对 `localhost` 目标有意义**：
   * 指向其它机器的目标不在本机扫描范围内，不能据此外推它不存在。
   */
  listeningOnServer: boolean;
  /** 同目标在服务器上扫描到的进程名；没扫到为空。 */
  process: string;
}

function rowKey(host: string, port: number) {
  return `${host}|${port}`;
}

/** 指向服务器本机的目标（`127.0.0.1` 与 `localhost` 对 sshd 是一回事）。 */
export function isLoopbackTarget(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

/**
 * 合并三份数据成**一张列表**：活着的转发、跟着连接记住的备注/置顶、服务器扫描到的服务。
 * - 同一个目标只出一行（`localhost` 与 `127.0.0.1` 视为同一目标）；
 * - 备注**不改变行的位置或归属**：只做行内说明，记住但没转发的目标按端口排序；
 * - 排序只由「置顶 → 正在转发 → 端口号」决定，所以只有点图钉才会把行提到最前。
 */
export function mergeForwardRows(
  forwards: readonly PortForwardInfo[],
  notes: readonly PortForwardNote[],
  services: readonly ListeningService[],
): ForwardRow[] {
  const sameHost = (a: string, b: string) =>
    a === b || (isLoopbackTarget(a) && isLoopbackTarget(b));
  const serviceFor = (host: string, port: number) =>
    services.find((s) => s.port === port && sameHost(host, s.targetHost));

  const rows = new Map<string, ForwardRow>();
  const blankRow = (host: string, port: number): ForwardRow => ({
    key: rowKey(host, port),
    remoteHost: host,
    remotePort: port,
    note: '',
    pinned: false,
    listeningOnServer: serviceFor(host, port) !== undefined,
    process: serviceFor(host, port)?.process ?? '',
  });

  for (const forward of forwards) {
    const row = blankRow(forward.remoteHost, forward.remotePort);
    rows.set(row.key, { ...row, forward });
  }

  for (const note of notes) {
    if (!note.note.trim() && !note.pinned) continue;
    const key = rowKey(note.host, note.port);
    const existing = rows.get(key);
    if (existing) {
      existing.note = note.note;
      existing.pinned = note.pinned;
    } else {
      rows.set(key, { ...blankRow(note.host, note.port), note: note.note, pinned: note.pinned });
    }
  }

  for (const service of services) {
    const covered = [...rows.values()].some(
      (row) => row.remotePort === service.port && sameHost(row.remoteHost, service.targetHost),
    );
    if (covered) continue;
    const row = blankRow(service.targetHost, service.port);
    row.process = service.process;
    rows.set(row.key, row);
  }

  return [...rows.values()].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      Number(Boolean(b.forward)) - Number(Boolean(a.forward)) ||
      a.remotePort - b.remotePort ||
      a.remoteHost.localeCompare(b.remoteHost),
  );
}
