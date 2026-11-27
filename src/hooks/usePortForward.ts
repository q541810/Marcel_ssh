import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import * as tauri from '@/lib/tauri';
import type { PortForwardInfo } from '@/lib/tauri';
import { getErrorMessage } from '@/lib/errors';
import { isDebugConnection } from '@/lib/debugServer';
import { toListeningServices, type ListeningService } from '@/lib/portForward';
import { useSessionStore } from '@/stores/sessionStore';
import { useConnectionStore } from '@/stores/connectionStore';

const CHANGED_EVENT = 'port-forward://changed';
/** 连接数/在线状态没有事件，面板开着时轻轮询（纯内存读取，开销可忽略）。 */
const POLL_MS = 3000;

/**
 * 端口转发的状态与动作，桌面底栏面板与手机 Sheet 共用。
 * 转发本身活在后端（跟着会话走），这里只是它的一个视图：面板关了转发照常工作。
 *
 * 备注 / 置顶跟着**保存的连接**走，所以直接读连接库里的 `portForwards`；
 * 写入经后端落盘（会广播同步），写完静默重读连接列表。
 */
export function usePortForward(sessionId: string) {
  const [forwards, setForwards] = useState<PortForwardInfo[]>([]);
  const [services, setServices] = useState<ListeningService[]>([]);
  const [scanning, setScanning] = useState(false);
  /** 是否至少成功扫过一次：没扫过就不知道服务器上有什么，不能提示「未在监听」。 */
  const [scanned, setScanned] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const configId = useSessionStore((s) => s.sessions[sessionId]?.configId);
  const sessionConnected = useSessionStore(
    (s) => s.sessions[sessionId]?.status === 'connected',
  );
  const connections = useConnectionStore((s) => s.connections);
  /** 临时 / 调试连接没有已保存的连接 id，备注无处可记。 */
  const canRemember = Boolean(configId && !isDebugConnection(configId));
  const notes = useMemo(
    () =>
      (canRemember
        ? connections.find((c) => c.id === configId)?.portForwards ?? []
        : []),
    [canRemember, connections, configId],
  );

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
      setScanned(true);
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

  /** 记下 / 更新一条转发的备注与置顶；空备注且不置顶 = 删掉这条记录。 */
  const setNote = useCallback(
    async (host: string, port: number, note: string, pinned: boolean) => {
      if (!configId || !canRemember) return;
      try {
        await tauri.portForwardNoteSet(configId, host, port, note, pinned);
        setError(null);
        await useConnectionStore.getState().fetchConnections({ silent: true });
      } catch (err) {
        setError(getErrorMessage(err));
      }
    },
    [configId, canRemember],
  );

  return {
    forwards,
    services,
    notes,
    scanned,
    scanning,
    error,
    canRemember,
    sessionConnected,
    scan,
    start,
    stop,
    setNote,
  };
}
