import { useEffect, useMemo, useState } from 'react';
import {
  fileParentDir,
  relativeCandidates,
  resolveFileMachine,
  type FileRef,
  type MachineResolution,
  type RelativeBase,
  type RelativeCandidate,
} from '@/lib/fileLink';
import { boundSessionOf, findProjectRoot, getRemoteHome, isMobileShell } from '@/lib/fileNav';
import { useFileNavStore } from '@/stores/fileNavStore';
import { useConnectionStore } from '@/stores/connectionStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useSessionStore } from '@/stores/sessionStore';

/**
 * 这个文件引用落在哪台机器上（响应式）：会话连上 / 断开、连接改名都会让结果跟着变，
 * 链接据此启用或禁用。点击时 `fileNav` 会再解析一次，这里只负责「现在能不能点」和 tooltip 文案。
 */
export function useFileMachine(
  ref: Pick<FileRef, 'side' | 'host'>,
  conversationId: string | null | undefined,
): MachineResolution {
  const sessions = useSessionStore((s) => s.sessions);
  const connections = useConnectionStore((s) => s.connections);
  // 订阅「谁占着哪条对话」：绑定变化要重算；占用关系本身由 manager 读 store 现算
  const bindings = useConversationStore((s) => s.activeConversationBySession);
  return useMemo(
    () =>
      resolveFileMachine(ref, {
        boundSessionId: boundSessionOf(conversationId),
        sessions,
        connections,
        mobile: isMobileShell(),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ref.side, ref.host, conversationId, sessions, connections, bindings],
  );
}

/**
 * 「复制相对路径」的候选（菜单打开时才按需取，带缓存）：文件管理当前目录（store 里现成）、
 * 家目录、项目根目录（往上找 .git，要发请求）。终端当前目录没有可靠来源，不提供。
 */
export function useRelativeCandidates(
  file: FileRef,
  sessionId: string | null,
  enabled: boolean,
): RelativeCandidate[] {
  const viewing = useFileNavStore((s) => (sessionId ? s.viewingDir[sessionId] : undefined));
  const [loaded, setLoaded] = useState<{ key: string; home: string | null; project: string | null } | null>(null);
  const key = `${file.side}:${sessionId ?? ''}:${file.path}`;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const startDir = file.isDir ? file.path : fileParentDir(file.path);
    const sid = file.side === 'remote' ? sessionId : null;
    if (file.side === 'remote' && !sid) return;
    void Promise.all([
      file.side === 'remote' && sid ? getRemoteHome(sid) : Promise.resolve(null),
      findProjectRoot(file.side, sid, startDir),
    ]).then(([home, project]) => {
      if (!cancelled) setLoaded({ key, home, project });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, key, file.side, file.path, file.isDir, sessionId]);

  return useMemo(() => {
    const bases: RelativeBase[] = [];
    if (file.side === 'remote' && viewing) bases.push({ id: 'fileManager', dir: viewing });
    if (loaded && loaded.key === key) {
      if (loaded.project) bases.push({ id: 'project', dir: loaded.project });
      if (loaded.home) bases.push({ id: 'home', dir: loaded.home });
    }
    return relativeCandidates(file.path, bases);
  }, [file.side, file.path, viewing, loaded, key]);
}
