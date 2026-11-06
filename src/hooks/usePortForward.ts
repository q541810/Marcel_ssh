import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import * as tauri from '@/lib/tauri';
import type { PortForwardInfo } from '@/lib/tauri';
import { getErrorMessage } from '@/lib/errors';
import { toListeningServices, type ListeningService } from '@/lib/portForward';

const CHANGED_EVENT = 'port-forward://changed';
/** 连接数/在线状态没有事件，面板开着时轻轮询（纯内存读取，开销可忽略）。 */
const POLL_MS = 3000;

/**
 * 端口转发的状态与动作，桌面底栏面板与手机 Sheet 共用。
 * 转发本身活在后端（跟着会话走），这里只是它的一个视图：面板关了转发照常工作。
 */
export function usePortForward(sessionId: string) {
  const [forwards, setForwards] = useState<PortForwardInfo[]>([]);
  const [services, setServices] = useState<ListeningService[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const refreshForwards = useCallback(async () => {
    try {
      const list = await tauri.portForwardList(sessionId);
      if (alive.current) setForwards(list);
    } catch (err) {
      if (alive.current) setError(getErrorMessage(err));
    }
  }, [sessionId]);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const sockets = await tauri.sshListListeners(sessionId);
      if (!alive.current) return;
      setServices(toListeningServices(sockets));
      setError(null);
    } catch (err) {
      if (alive.current) setError(`读取服务器上的服务失败：${getErrorMessage(err)}`);
    } finally {
      if (alive.current) setScanning(false);
    }
  }, [sessionId]);

  useEffect(() => {
    alive.current = true;
    void refreshForwards();
    void scan();
    const timer = setInterval(() => void refreshForwards(), POLL_MS);
    let unlisten: (() => void) | undefined;
    void listen<string>(CHANGED_EVENT, (e) => {
      if (e.payload === sessionId) void refreshForwards();
    }).then((fn) => {
      if (alive.current) unlisten = fn;
      else fn();
    });
    return () => {
      alive.current = false;
      clearInterval(timer);
      unlisten?.();
    };
  }, [sessionId, refreshForwards, scan]);

  const start = useCallback(
    async (host: string, port: number, localPort?: number): Promise<PortForwardInfo | null> => {
      try {
        const info = await tauri.portForwardStart(sessionId, host, port, localPort);
        setError(null);
        await refreshForwards();
        return info;
      } catch (err) {
        setError(getErrorMessage(err));
        return null;
      }
    },
    [sessionId, refreshForwards],
  );

  const stop = useCallback(
    async (forwardId: string) => {
      try {
        await tauri.portForwardStop(forwardId);
      } catch (err) {
        setError(getErrorMessage(err));
      }
      await refreshForwards();
    },
    [refreshForwards],
  );

  return { forwards, services, scanning, error, scan, start, stop };
}
