import { describe, expect, it } from 'vitest';
import type { RemoteSocketInfo } from './remoteSystem';
import type { PortForwardInfo } from './tauri';
import { forwardHealth, forwardUrl, parseForwardTarget, toListeningServices } from './portForward';

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
