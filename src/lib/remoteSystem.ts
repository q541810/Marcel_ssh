/**
 * Remote system-panel helpers.
 *
 * The desktop SSH client can connect to both POSIX hosts and Windows hosts
 * running OpenSSH. The process/network panels used to execute Linux-only
 * commands unconditionally, which made Windows sessions silently render an
 * empty table (a non-zero command exit is not surfaced by `ssh_exec`).
 *
 * This module keeps the platform-specific command construction and output
 * parsing out of the React components. Tauri wrappers decide which command to
 * run after probing the remote shell once per session.
 */

import type { RemotePlatform } from './types';

export interface RemoteProcessInfo {
  pid: string;
  user: string;
  cpu: number;
  mem: number;
  etime: string;
  comm: string;
  args: string;
}

export interface RemoteSocketInfo {
  proto: string;
  laddr: string;
  lport: number;
  raddr: string;
  rport: number;
  state: string;
  pid: number;
  process: string;
}

export interface RemoteNetworkInterface {
  name: string;
  ip: string;
  mac: string;
  state: string;
}

export interface RemoteNetworkSnapshot {
  sockets: RemoteSocketInfo[];
  interfaces: RemoteNetworkInterface[];
}

export const WINDOWS_PROBE_MARKER = '@@MARCEL_WINDOWS@@';
export const WINDOWS_PROCESS_MARKER = '@@MARCEL_WINDOWS_PROCESS@@';
export const WINDOWS_NETWORK_MARKER = '@@MARCEL_WINDOWS_NETWORK@@';
export const WINDOWS_TERMINATED_MARKER = '@@MARCEL_PROCESS_TERMINATED@@';
export const WINDOWS_KILL_FAILED_MARKER = '@@MARCEL_PROCESS_KILL_FAILED@@';

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** PowerShell -EncodedCommand expects base64(UTF-16LE). */
function encodePowerShell(script: string): string {
  const bytes = new Uint8Array(script.length * 2);
  for (let i = 0; i < script.length; i += 1) {
    const code = script.charCodeAt(i);
    bytes[i * 2] = code & 0xff;
    bytes[i * 2 + 1] = code >> 8;
  }

  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    result += BASE64_ALPHABET[b0 >> 2];
    result += BASE64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    result += i + 1 < bytes.length
      ? BASE64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)]
      : '=';
    result += i + 2 < bytes.length
      ? BASE64_ALPHABET[b2 & 0x3f]
      : '=';
  }
  return result;
}

function powershellCommand(script: string): string {
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell(script)}`;
}

const WINDOWS_PROBE_SCRIPT = `Write-Output '${WINDOWS_PROBE_MARKER}'`;

const WINDOWS_PROCESS_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$marker = '${WINDOWS_PROCESS_MARKER}'

$totalMemory = 0.0
$computer = Get-CimInstance Win32_ComputerSystem
if ($null -ne $computer) {
  $totalMemory = [double]$computer.TotalPhysicalMemory
}

$cpuByPid = @{}
Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | ForEach-Object {
  $processId = [int]$_.IDProcess
  if ($processId -gt 0) {
    $cpuByPid[$processId] = [double]$_.PercentProcessorTime
  }
}

$commandLineByPid = @{}
Get-CimInstance Win32_Process | ForEach-Object {
  $processId = [int]$_.ProcessId
  if ($processId -gt 0) {
    $commandLineByPid[$processId] = [string]$_.CommandLine
  }
}

$rows = foreach ($process in (Get-Process)) {
  $processId = [int]$process.Id
  $cpu = 0.0
  if ($cpuByPid.ContainsKey($processId)) {
    $cpu = [double]$cpuByPid[$processId]
  }

  $mem = 0.0
  if ($totalMemory -gt 0 -and $null -ne $process.WorkingSet64) {
    $mem = 100.0 * [double]$process.WorkingSet64 / $totalMemory
  }

  $elapsed = ''
  if ($null -ne $process.StartTime) {
    # Same shape as ps etime: [d-]hh:mm:ss (TimeSpan.ToString() would add ticks).
    $span = (Get-Date) - $process.StartTime
    if ($span.Days -gt 0) {
      $elapsed = '{0}-{1:00}:{2:00}:{3:00}' -f $span.Days, $span.Hours, $span.Minutes, $span.Seconds
    } else {
      $elapsed = '{0:00}:{1:00}:{2:00}' -f $span.Hours, $span.Minutes, $span.Seconds
    }
  }

  $commandLine = ''
  if ($commandLineByPid.ContainsKey($processId)) {
    $commandLine = [string]$commandLineByPid[$processId]
  }
  if ([string]::IsNullOrWhiteSpace($commandLine)) {
    $commandLine = [string]$process.Path
  }

  [PSCustomObject]@{
    pid = [string]$processId
    user = '-'
    cpu = [math]::Round($cpu, 1)
    mem = [math]::Round($mem, 1)
    etime = $elapsed
    comm = [string]$process.ProcessName
    args = $commandLine
  }
}

Write-Output $marker
if ($null -eq $rows) {
  Write-Output '[]'
} else {
  $rows | ConvertTo-Json -Compress -Depth 3
}
`;

const WINDOWS_NETWORK_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$marker = '${WINDOWS_NETWORK_MARKER}'

$processNames = @{}
Get-Process | ForEach-Object {
  $processNames[[int]$_.Id] = [string]$_.ProcessName
}

$processRows = @()
foreach ($entry in $processNames.GetEnumerator()) {
  $processRows += [PSCustomObject]@{
    pid = [int]$entry.Key
    name = [string]$entry.Value
  }
}

$adapters = @(Get-NetAdapter)
$addresses = @(Get-NetIPAddress)
$interfaces = @()
foreach ($adapter in $adapters) {
  $address = $addresses |
    Where-Object { [int]$_.InterfaceIndex -eq [int]$adapter.ifIndex } |
    Sort-Object { if ($_.AddressFamily -eq 'IPv4') { 0 } else { 1 } } |
    Select-Object -First 1

  $ip = '-'
  if ($null -ne $address) {
    $ip = [string]$address.IPAddress
    if ($null -ne $address.PrefixLength) {
      $ip = $ip + '/' + [string]$address.PrefixLength
    }
  }

  $mac = [string]$adapter.MacAddress
  if ([string]::IsNullOrWhiteSpace($mac)) {
    $mac = '-'
  }

  $state = 'DOWN'
  if ([string]$adapter.Status -eq 'Up') {
    $state = 'UP'
  } elseif (-not [string]::IsNullOrWhiteSpace([string]$adapter.Status)) {
    $state = ([string]$adapter.Status).ToUpperInvariant()
  }

  $interfaces += [PSCustomObject]@{
    name = [string]$adapter.Name
    ip = $ip
    mac = $mac
    state = $state
  }
}

$payload = [PSCustomObject]@{
  netstat = @(& netstat.exe -ano)
  processes = @($processRows)
  interfaces = @($interfaces)
}

Write-Output $marker
$payload | ConvertTo-Json -Compress -Depth 5
`;

const WINDOWS_KILL_SCRIPT = String.raw`
$ProgressPreference = 'SilentlyContinue'
# An SSH exec channel without a pty may have no console handle, in which case
# setting OutputEncoding throws; that must never stop the kill from running.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
$processId = __PID__
try {
  Stop-Process -Id $processId -Force -ErrorAction Stop
  Write-Output '${WINDOWS_TERMINATED_MARKER}'
} catch {
  Write-Output ('${WINDOWS_KILL_FAILED_MARKER}' + $_.Exception.Message)
}
`;

export const WINDOWS_PROBE_COMMAND = powershellCommand(WINDOWS_PROBE_SCRIPT);
export const WINDOWS_PROCESS_COMMAND = powershellCommand(WINDOWS_PROCESS_SCRIPT);
export const WINDOWS_NETWORK_COMMAND = powershellCommand(WINDOWS_NETWORK_SCRIPT);

export const POSIX_UNAME_COMMAND =
  'uname -s 2>/dev/null || echo unknown';

/** Map `uname -s` output (or a Windows-MINGW shell name) to a display platform. */
export function classifyRemotePlatform(output: string): RemotePlatform | null {
  const normalized = output.trim().toUpperCase();
  if (!normalized) return null;
  if (/^(MINGW|MSYS|CYGWIN)/.test(normalized)) return 'windows';
  if (normalized.includes('LINUX')) return 'linux';
  if (normalized.includes('DARWIN')) return 'macos';
  if (/(FREEBSD|OPENBSD|NETBSD|SUNOS|AIX|UNIX)/.test(normalized)) return 'unix';
  return null;
}

export const POSIX_PROCESS_COMMAND =
  'ps -eo pid,user,pcpu,pmem,etime,comm,args --no-headers 2>/dev/null || ' +
  'ps -eo pid,user,pcpu,pmem,etime,comm,args --no-headers';

export const POSIX_NETWORK_COMMAND =
  '(ss -Htlnp 2>/dev/null || ss -tlnp 2>/dev/null); ' +
  'echo "---CONNECTIONS---"; ' +
  '(ss -Htnp 2>/dev/null || ss -tnp 2>/dev/null)';

/** 只读监听端口（端口转发的“服务器上有哪些服务”用），比 POSIX_NETWORK_COMMAND 少查一遍活动连接。 */
export const POSIX_LISTEN_COMMAND =
  '(ss -Htlnp 2>/dev/null || ss -tlnp 2>/dev/null)';

export const POSIX_INTERFACES_COMMAND =
  'ip -j addr 2>/dev/null || ip addr 2>/dev/null || ifconfig 2>/dev/null';

export function windowsKillCommand(pid: string | number): string | null {
  const raw = String(pid).trim();
  if (!/^\d+$/.test(raw)) return null;
  return powershellCommand(WINDOWS_KILL_SCRIPT.replace('__PID__', raw));
}

/**
 * Interpret the output of `windowsKillCommand`: `null` = terminated, otherwise
 * the message to show. Only text after our own marker is surfaced, so
 * PowerShell's CLIXML progress noise on stderr never reaches the UI.
 */
export function parseWindowsKillFailure(output: string): string | null {
  if (output.includes(WINDOWS_TERMINATED_MARKER)) return null;
  const index = output.indexOf(WINDOWS_KILL_FAILED_MARKER);
  if (index < 0) return '未收到远端确认';
  const message = output.slice(index + WINDOWS_KILL_FAILED_MARKER.length).trim();
  return message || '远端未说明原因';
}

function parsePayloadAfterMarker(output: string, marker: string): unknown | null {
  const markerIndex = output.indexOf(marker);
  if (markerIndex < 0) return null;
  const payload = output.slice(markerIndex + marker.length).trim();
  if (!payload) return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNumber(value: unknown): number {
  const number = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(number) ? number : 0;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

export function parseWindowsProcessOutput(output: string): RemoteProcessInfo[] | null {
  const payload = parsePayloadAfterMarker(output, WINDOWS_PROCESS_MARKER);
  if (payload === null) return null;

  const rows = Array.isArray(payload) ? payload : [payload];
  return rows.flatMap((value) => {
    const row = asRecord(value);
    if (!row || row.pid == null) return [];
    return [{
      pid: asString(row.pid),
      user: asString(row.user) || '-',
      cpu: Math.max(0, asNumber(row.cpu)),
      mem: Math.max(0, asNumber(row.mem)),
      etime: asString(row.etime),
      comm: asString(row.comm),
      args: asString(row.args),
    }];
  });
}

function splitAddressPort(value: string): [string, number] {
  const address = value.trim();
  const bracketed = address.match(/^\[(.*)\]:([^:]*)$/);
  if (bracketed) {
    return [bracketed[1] || '*', Number.parseInt(bracketed[2], 10) || 0];
  }
  const separator = address.lastIndexOf(':');
  if (separator < 0) return [address || '*', 0];
  return [
    address.slice(0, separator) || '*',
    Number.parseInt(address.slice(separator + 1), 10) || 0,
  ];
}

function normalizeWindowsState(state: string, proto: string): string {
  const upper = state.toUpperCase();
  if (upper === 'LISTENING') return 'LISTEN';
  if (upper === 'TIMEWAIT') return 'TIME_WAIT';
  if (upper === 'CLOSEWAIT') return 'CLOSE_WAIT';
  if (upper === 'FINWAIT1') return 'FIN_WAIT1';
  if (upper === 'FINWAIT2') return 'FIN_WAIT2';
  if (upper === 'SYNSENT') return 'SYN_SENT';
  if (upper === 'SYNRECEIVED') return 'SYN_RECV';
  if (proto.endsWith('6') && upper === 'LISTEN') return 'LISTEN';
  return upper || 'UNKNOWN';
}

function parseWindowsNetstat(
  lines: string[],
  processNames: Map<number, string>,
): RemoteSocketInfo[] {
  const sockets: RemoteSocketInfo[] = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length === 0) continue;
    const protocol = parts[0]?.toUpperCase();
    if (protocol !== 'TCP' && protocol !== 'UDP') continue;

    const isTcp = protocol === 'TCP';
    if (isTcp && parts.length < 5) continue;
    if (!isTcp && parts.length < 4) continue;

    const [laddrRaw, lport] = splitAddressPort(parts[1] ?? '');
    const [raddrRaw, rport] = splitAddressPort(parts[2] ?? '');
    const state = isTcp ? normalizeWindowsState(parts[3] ?? '', protocol) : 'LISTEN';
    const pid = Number.parseInt(isTcp ? parts[4] : parts[3], 10) || 0;
    const isIpv6 = laddrRaw.includes(':') || raddrRaw.includes(':');
    const proto = isIpv6 ? `${protocol.toLowerCase()}6` : protocol.toLowerCase();

    sockets.push({
      proto,
      laddr: laddrRaw,
      lport,
      raddr: isTcp ? raddrRaw : '',
      rport: isTcp ? rport : 0,
      state,
      pid,
      process: processNames.get(pid) || '-',
    });
  }
  return sockets;
}

export function parseWindowsNetworkOutput(output: string): RemoteNetworkSnapshot | null {
  const payload = parsePayloadAfterMarker(output, WINDOWS_NETWORK_MARKER);
  const root = asRecord(payload);
  if (!root) return null;

  const processNames = new Map<number, string>();
  if (Array.isArray(root.processes)) {
    for (const value of root.processes) {
      const row = asRecord(value);
      if (!row) continue;
      const pid = Number.parseInt(asString(row.pid), 10);
      if (pid > 0) processNames.set(pid, asString(row.name));
    }
  }

  const netstat = Array.isArray(root.netstat)
    ? root.netstat.map(asString)
    : [];
  const sockets = parseWindowsNetstat(netstat, processNames);

  const interfaces = Array.isArray(root.interfaces)
    ? root.interfaces.flatMap((value) => {
        const row = asRecord(value);
        if (!row) return [];
        return [{
          name: asString(row.name) || 'unknown',
          ip: asString(row.ip) || '-',
          mac: asString(row.mac) || '-',
          state: (asString(row.state) || 'DOWN').toUpperCase(),
        }];
      })
    : [];

  return { sockets, interfaces };
}

export function parsePosixProcessOutput(output: string): RemoteProcessInfo[] {
  const lines = output.split('\n').filter((line) => line.trim());
  const isNumber = (value: string) => /^\d+(\.\d+)?$/.test(value);

  return lines.flatMap((line) => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) return [];

    let pid: string;
    let user: string;
    let cpu: number;
    let mem: number;
    let etime: string;
    let comm: string;
    let args: string;

    if (isNumber(parts[2])) {
      pid = parts[0];
      user = parts[1];
      cpu = Number.parseFloat(parts[2]) || 0;
      mem = Number.parseFloat(parts[3]) || 0;
      etime = parts[4];
      comm = parts[5];
      args = parts.slice(6).join(' ');
    } else {
      pid = parts[0];
      user = parts[1];
      comm = parts[2];
      cpu = Number.parseFloat(parts[3]) || 0;
      mem = Number.parseFloat(parts[4]) || 0;
      etime = parts[5];
      args = parts.slice(6).join(' ');
    }

    return [{ pid, user, cpu, mem, etime, comm, args }];
  });
}

function parseAddress(value: string): [string, string] {
  if (!value) return ['*', '0'];
  const bracketed = value.match(/^\[([^\]]+)\]:(\d+|\*)$/);
  if (bracketed) return [bracketed[1], bracketed[2]];
  const separator = value.lastIndexOf(':');
  if (separator < 0) return [value, '0'];
  return [value.substring(0, separator), value.substring(separator + 1)];
}

function parseSsLine(line: string): RemoteSocketInfo | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (/^State\s/i.test(trimmed)) return null;

  const parts = trimmed.split(/\s+/);
  if (parts.length < 5) return null;

  const state = parts[0];
  let addressStart = -1;
  for (let i = 1; i < parts.length; i += 1) {
    if (parts[i].includes(':')) {
      addressStart = i;
      break;
    }
  }
  if (addressStart < 0) return null;

  const [laddr, lport] = parseAddress(parts[addressStart]);
  const [raddr, rport] = parseAddress(parts[addressStart + 1] || '');
  let processName = '-';
  let pid = 0;

  const processRaw = addressStart + 2 < parts.length ? parts[addressStart + 2] : '';
  if (processRaw) {
    const users = processRaw.match(/users:\(\((.+?)\)\)$/);
    if (users) {
      const first = users[1].match(/"([^"]*)",pid=(\d+)/);
      if (first) {
        processName = first[1];
        pid = Number.parseInt(first[2], 10) || 0;
      }
    }
  }

  let proto = 'tcp';
  if (laddr.includes(':') || raddr.includes(':')) proto = 'tcp6';
  return {
    proto,
    laddr,
    lport: Number.parseInt(lport, 10) || 0,
    raddr,
    rport: Number.parseInt(rport, 10) || 0,
    state,
    pid,
    process: processName,
  };
}

export function parsePosixNetworkOutput(output: string): RemoteSocketInfo[] {
  return output.split('\n').flatMap((line) => {
    const parsed = parseSsLine(line);
    return parsed ? [parsed] : [];
  });
}

export function parsePosixInterfaces(output: string): RemoteNetworkInterface[] {
  const trimmed = output.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[')) {
    try {
      const json = JSON.parse(trimmed);
      if (Array.isArray(json)) {
        return json.flatMap((value) => {
          const iface = asRecord(value);
          if (!iface || typeof iface.ifname !== 'string') return [];
          const addresses = Array.isArray(iface.addr_info) ? iface.addr_info : [];
          const ipv4 = addresses
            .map(asRecord)
            .find((address) => address?.family === 'inet');
          const ip = ipv4
            ? `${asString(ipv4.local)}/${asString(ipv4.prefixlen)}`
            : '-';
          const flags = Array.isArray(iface.flags) ? iface.flags.map(asString) : [];
          return [{
            name: iface.ifname,
            ip,
            mac: asString(iface.address) || '-',
            state: asString(iface.operstate) || (flags.includes('UP') ? 'UP' : 'DOWN'),
          }];
        });
      }
    } catch {
      // Fall through to `ip addr` / ifconfig parsing.
    }
  }

  const result: RemoteNetworkInterface[] = [];
  const lines = output.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(/^\d+:\s*(\S+?)(?:@\S+)?:\s*<(.+?)>.*?\bstate\s+(\S+)/);
    if (!match) continue;
    const name = match[1];
    const flags = match[2];
    const state = match[3].toUpperCase();
    const up = flags.includes('UP') && state !== 'DOWN';

    let mac = '-';
    let ip = '-';
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j];
      if (/^\d+:/.test(next)) break;
      const macMatch = next.match(/link\/(?:ether|loopback)\s+(\S+)/);
      if (macMatch) mac = macMatch[1];
      const ipMatch = next.match(/^\s+inet\s+(\S+)/);
      if (ipMatch && ip === '-') ip = ipMatch[1];
    }
    result.push({ name, ip, mac, state: up ? 'UP' : 'DOWN' });
  }
  return result;
}
