import { describe, expect, it } from 'vitest';
import type { RemoteSocketInfo } from './remoteSystem';
import type { PortForwardInfo } from './tauri';
import type { PortForwardNote } from './types';
import {
  forwardHealth,
  forwardUrl,
  mergeForwardRows,
  parseForwardTarget,
  toListeningServices,
} from './portForward';

const sock = (over: Partial<RemoteSocketInfo>): RemoteSocketInfo => ({
  proto: 'tcp', laddr: '0.0.0.0', lport: 80, raddr: '*', rport: 0, state: 'LISTEN', pid: 0, process: '-', ...over,
});

describe('toListeningServices', () => {
  it('只留 TCP 监听，IPv4/IPv6 同端口去重并保留进程名', () => {
    const list = toListeningServices([
      sock({ lport: 3000, laddr: '::', proto: 'tcp6' }),
      sock({ lport: 3000, laddr: '0.0.0.0', process: 'node' }),
      sock({ lport: 9, state: 'ESTAB' }),
      sock({ lport: 53, proto: 'udp' }),
    ]);
    expect(list).toEqual([{ port: 3000, targetHost: 'localhost', process: 'node' }]);
  });
  it('回环和通配都走 localhost，绑具体网卡的用原 IP，并去掉 %网卡 后缀', () => {
    const list = toListeningServices([
      sock({ lport: 1, laddr: '127.0.0.1' }),
      sock({ lport: 2, laddr: '::1' }),
      sock({ lport: 3, laddr: '10.0.0.5' }),
      sock({ lport: 4, laddr: '127.0.0.53%lo' }),
    ]);
    expect(list.map((s) => s.targetHost)).toEqual(['localhost', 'localhost', '10.0.0.5', '127.0.0.53']);
  });
  it('按端口升序', () => {
    expect(toListeningServices([sock({ lport: 8080 }), sock({ lport: 22 })]).map((s) => s.port)).toEqual([22, 8080]);
  });
});

describe('parseForwardTarget', () => {
  it('纯端口默认 localhost，host:port 和 [v6]:port 都认', () => {
    expect(parseForwardTarget(' 3000 ')).toEqual({ host: 'localhost', port: 3000 });
    expect(parseForwardTarget('10.0.0.5:3306')).toEqual({ host: '10.0.0.5', port: 3306 });
    expect(parseForwardTarget('[::1]:80')).toEqual({ host: '::1', port: 80 });
  });
  it('非法输入返回 null', () => {
    for (const bad of ['', 'abc', '0', '70000', ':80', 'host:']) expect(parseForwardTarget(bad)).toBeNull();
  });
});

describe('forward helpers', () => {
  const base: PortForwardInfo = {
    id: 'a', sessionId: 's', remoteHost: 'localhost', remotePort: 8080, localPort: 18080,
    sessionOnline: true, activeConnections: 0, totalConnections: 0, lastError: null,
  };
  it('443/8443 走 https，其余 http', () => {
    expect(forwardUrl(base)).toBe('http://127.0.0.1:18080');
    expect(forwardUrl({ ...base, remotePort: 443 })).toBe('https://127.0.0.1:18080');
  });
  it('健康状态：离线优先于报错', () => {
    expect(forwardHealth(base)).toBe('ok');
    expect(forwardHealth({ ...base, lastError: 'x' })).toBe('error');
    expect(forwardHealth({ ...base, lastError: 'x', sessionOnline: false })).toBe('offline');
  });
});

describe('mergeForwardRows', () => {
  const forward = (over: Partial<PortForwardInfo>): PortForwardInfo => ({
    id: 'f', sessionId: 's', remoteHost: 'localhost', remotePort: 3000, localPort: 3000,
    sessionOnline: true, activeConnections: 0, totalConnections: 0, lastError: null, ...over,
  });
  const note = (over: Partial<PortForwardNote>): PortForwardNote => ({
    id: 'localhost|3000', host: 'localhost', port: 3000, note: '', pinned: false, ...over,
  });
  const service = (port: number, targetHost = 'localhost') => ({ port, targetHost, process: '' });

  it('同一目标只出一行，活转发与备注合并', () => {
    const rows = mergeForwardRows([forward({})], [note({ note: '前端' })], [service(3000)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ note: '前端', pinned: false, listeningOnServer: true });
    expect(rows[0].forward?.remotePort).toBe(3000);
  });

  it('只有备注或置顶的条目在没开启时也保留；空备注且未置顶的忽略', () => {
    const rows = mergeForwardRows(
      [],
      [note({ note: '数据库', port: 3306 }), note({ port: 9000 }), note({ pinned: true, port: 8080 })],
      [],
    );
    expect(rows.map((r) => r.remotePort)).toEqual([8080, 3306]);
    expect(rows.every((r) => !r.forward)).toBe(true);
  });

  it('排序：置顶 → 正在转发 → 其余，同档按端口', () => {
    const rows = mergeForwardRows(
      [forward({ remotePort: 3000 })],
      [
        note({ port: 9000, note: 'a' }),
        note({ port: 7000, pinned: true }),
        note({ port: 8000, note: 'b' }),
      ],
      [],
    );
    expect(rows.map((r) => [r.remotePort, r.pinned, Boolean(r.forward)])).toEqual([
      [7000, true, false],
      [3000, false, true],
      [8000, false, false],
      [9000, false, false],
    ]);
  });

  it('是否在监听按 host+端口匹配，别的主机不算；127.0.0.1 与 localhost 等价', () => {
    const rows = mergeForwardRows(
      [],
      [
        note({ host: 'localhost', port: 3000, note: '本机' }),
        note({ host: '127.0.0.1', port: 4000, note: '本机别名' }),
        note({ host: '10.0.0.5', port: 5432, note: '库' }),
      ],
      [service(3000), service(4000), service(5432, '10.0.0.6')],
    );
    // 指向 10.0.0.6 的服务是另一个目标，单独成行，不能顶掉 10.0.0.5 的备注行。
    expect(rows.map((r) => [r.remoteHost, r.remotePort, r.listeningOnServer])).toEqual([
      ['localhost', 3000, true],
      ['127.0.0.1', 4000, true],
      ['10.0.0.5', 5432, false],
      ['10.0.0.6', 5432, true],
    ]);
  });

  it('扫描到的服务也进同一份列表；已转发 / 已记住的同目标不重复，进程名带上来', () => {
    const rows = mergeForwardRows(
      [forward({ remotePort: 3000 })],
      [note({ host: '127.0.0.1', port: 4000, note: '本机别名' })],
      [
        { port: 3000, targetHost: 'localhost', process: 'node' },
        { port: 4000, targetHost: 'localhost', process: 'mysql' },
        { port: 22, targetHost: 'localhost', process: 'sshd' },
      ],
    );
    // 正在转发的排最前，其余按端口；3000 / 4000 只出一行。
    expect(rows.map((r) => r.remotePort)).toEqual([3000, 22, 4000]);
    expect(rows.map((r) => r.process)).toEqual(['node', 'sshd', 'mysql']);
    expect(rows[1].forward).toBeUndefined();
    expect(rows[1]).toMatchObject({ note: '', pinned: false, listeningOnServer: true, process: 'sshd' });
  });
});
