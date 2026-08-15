import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { sshExec, sshListProcesses } from '@/lib/tauri';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { getErrorMessage } from '@/lib/errors';

interface ProcessInfo {
  pid: string;
  user: string;
  cpu: number;
  mem: number;
  etime: string;
  comm: string;
  args: string;
}

type SortKey = 'pid' | 'user' | 'comm' | 'mem' | 'cpu' | 'etime' | 'args';
type SortDir = 'asc' | 'desc';

interface ProcessPanelProps {
  sessionId: string;
}

export default function ProcessPanel({ sessionId }: ProcessPanelProps) {
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuProcess, setMenuProcess] = useState<ProcessInfo | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [killConfirm, setKillConfirm] = useState<ProcessInfo | null>(null);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('cpu');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const menuRef = useRef<HTMLDivElement>(null);

  const loadProcesses = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const output = await sshListProcesses(sessionId);
      const lines = output.split('\n').filter((l) => l.trim());
      const parsed: ProcessInfo[] = lines.map((line) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 6) return null;

        const isNum = (s: string) => /^\d+(\.\d+)?$/.test(s);
        let pid: string, user: string, cpu: number, mem: number, etime: string, comm: string, args: string;

        if (isNum(parts[2])) {
          pid = parts[0]; user = parts[1]; cpu = parseFloat(parts[2]) || 0; mem = parseFloat(parts[3]) || 0; etime = parts[4]; comm = parts[5]; args = parts.slice(6).join(' ');
        } else {
          pid = parts[0]; user = parts[1]; comm = parts[2]; cpu = parseFloat(parts[3]) || 0; mem = parseFloat(parts[4]) || 0; etime = parts[5]; args = parts.slice(6).join(' ');
        }

        return { pid, user, cpu, mem, etime, comm, args };
      }).filter(Boolean) as ProcessInfo[];
      setProcesses(parsed);
    } catch (err) {
      setError(`加载失败：${getErrorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    loadProcesses();
  }, [loadProcesses]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuProcess(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filteredAndSorted = useMemo(() => {
    let list = processes;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((p) =>
        p.pid.includes(q) ||
        p.user.toLowerCase().includes(q) ||
        p.comm.toLowerCase().includes(q) ||
        p.args.toLowerCase().includes(q)
      );
    }
    return [...list].sort((a, b) => {
      const dir = sortDir === 'asc' ? 1 : -1;
      const aVal = a[sortKey];
      const bVal = b[sortKey];
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return (aVal - bVal) * dir;
      }
      return String(aVal).localeCompare(String(bVal)) * dir;
    });
  }, [processes, search, sortKey, sortDir]);

  const handleCopyInfo = async (proc: ProcessInfo) => {
    const text = `PID: ${proc.pid}\n用户: ${proc.user}\nCPU: ${proc.cpu}%\n内存: ${proc.mem}%\n运行时间: ${proc.etime}\n命令: ${proc.comm}\n参数: ${proc.args}`;
    try {
      await writeText(text);
    } catch {
      // ignore
    }
    setMenuProcess(null);
  };

  const handleKill = async (proc: ProcessInfo) => {
    setKillConfirm(null);
    setMenuProcess(null);
    try {
      await sshExec(sessionId, `kill -TERM ${proc.pid}`);
      await loadProcesses();
    } catch (err) {
      setError(`终止失败：${getErrorMessage(err)}`);
    }
  };

  const handleContextMenu = (e: React.MouseEvent, proc: ProcessInfo) => {
    e.preventDefault();
    setMenuProcess(proc);
    setMenuPos({ x: e.clientX, y: e.clientY });
  };

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const SortIcon = ({ active, dir }: { active: boolean; dir: SortDir }) => (
    <span className={`ml-1 inline-block ${active ? 'text-indigo-400' : 'text-zinc-600'}`}>
      {active ? (dir === 'asc' ? '↑' : '↓') : '↕'}
    </span>
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索进程..."
          className="flex-1 rounded-md bg-zinc-800 border border-zinc-700 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-indigo-500 placeholder:text-zinc-500"
        />
        <button
          type="button"
          onClick={loadProcesses}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
        >
          {loading && (
            <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
          )}
          {loading ? '刷新中...' : '刷新'}
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {error && <div className="px-3 py-2 text-xs text-red-300">{error}</div>}

        <table className="w-full text-xs table-fixed">
          <thead className="sticky top-0 bg-zinc-900 border-b border-zinc-800">
            <tr className="text-zinc-500">
              <th className="px-3 py-2 text-left font-medium w-16 whitespace-nowrap">
                <button type="button" onClick={() => toggleSort('pid')} className="flex items-center gap-1 hover:text-zinc-300 transition-colors">
                  PID <SortIcon active={sortKey === 'pid'} dir={sortDir} />
                </button>
              </th>
              <th className="px-3 py-2 text-left font-medium w-20 whitespace-nowrap">
                <button type="button" onClick={() => toggleSort('user')} className="flex items-center gap-1 hover:text-zinc-300 transition-colors">
                  用户 <SortIcon active={sortKey === 'user'} dir={sortDir} />
                </button>
              </th>
              <th className="px-3 py-2 text-left font-medium w-24 whitespace-nowrap">
                <button type="button" onClick={() => toggleSort('comm')} className="flex items-center gap-1 hover:text-zinc-300 transition-colors">
                  命令 <SortIcon active={sortKey === 'comm'} dir={sortDir} />
                </button>
              </th>
              <th className="px-3 py-2 text-left font-medium w-16 whitespace-nowrap">
                <button type="button" onClick={() => toggleSort('mem')} className="flex items-center gap-1 hover:text-zinc-300 transition-colors">
                  内存 <SortIcon active={sortKey === 'mem'} dir={sortDir} />
                </button>
              </th>
              <th className="px-3 py-2 text-left font-medium w-16 whitespace-nowrap">
                <button type="button" onClick={() => toggleSort('cpu')} className="flex items-center gap-1 hover:text-zinc-300 transition-colors">
                  CPU <SortIcon active={sortKey === 'cpu'} dir={sortDir} />
                </button>
              </th>
              <th className="px-3 py-2 text-left font-medium w-24 whitespace-nowrap">
                <button type="button" onClick={() => toggleSort('etime')} className="flex items-center gap-1 hover:text-zinc-300 transition-colors">
                  运行时间 <SortIcon active={sortKey === 'etime'} dir={sortDir} />
                </button>
              </th>
              <th className="px-3 py-2 text-left font-medium whitespace-nowrap">
                <button type="button" onClick={() => toggleSort('args')} className="flex items-center gap-1 hover:text-zinc-300 transition-colors">
                  参数 <SortIcon active={sortKey === 'args'} dir={sortDir} />
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="py-8 text-center">
                  <div className="flex items-center justify-center gap-2 text-xs text-zinc-400">
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    <span>加载进程中...</span>
                  </div>
                </td>
              </tr>
            ) : filteredAndSorted.map((proc) => (
              <tr
                key={proc.pid}
                className="border-b border-zinc-800/50 hover:bg-zinc-800/50 transition-colors cursor-pointer"
                onContextMenu={(e) => handleContextMenu(e, proc)}
              >
                <td className="px-3 py-1.5 text-zinc-300 truncate">{proc.pid}</td>
                <td className="px-3 py-1.5 text-zinc-300 truncate">{proc.user}</td>
                <td className="px-3 py-1.5 text-zinc-300 truncate max-w-[6rem]">{proc.comm}</td>
                <td className="px-3 py-1.5 text-zinc-300 truncate">{proc.mem}%</td>
                <td className="px-3 py-1.5 text-zinc-300 truncate">{proc.cpu}%</td>
                <td className="px-3 py-1.5 text-zinc-300 truncate">{proc.etime}</td>
                <td className="px-3 py-1.5 text-zinc-400 truncate">{proc.args}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {filteredAndSorted.length === 0 && !loading && !error && (
          <div className="py-8 text-center text-sm text-zinc-500">
            {search ? '无匹配进程' : '暂无进程数据'}
          </div>
        )}
      </div>

      {menuProcess && createPortal(
        <div
          ref={menuRef}
          className="win-flyout win-flyout-enter fixed z-50 w-40 py-1"
          style={{
            top: menuPos.y,
            left: menuPos.x,
          }}
        >
          <button
            type="button"
            onClick={() => handleCopyInfo(menuProcess)}
            className="win-menu-item text-xs"
          >
            复制所有信息
          </button>
          <button
            type="button"
            onClick={() => {
              setKillConfirm(menuProcess);
              setMenuProcess(null);
            }}
            className="win-menu-item win-menu-item--danger text-xs"
          >
            终止进程
          </button>
        </div>,
        document.body,
      )}

      {killConfirm && createPortal(
        <div className="win-dialog-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="win-dialog win-dialog-enter w-80 p-4">
            <h3 className="text-sm font-semibold text-red-500 mb-2">确认终止进程</h3>
            <p className="text-xs text-zinc-500 mb-1">
              PID: <span className="text-zinc-800 font-medium">{killConfirm.pid}</span>
            </p>
            <p className="text-xs text-zinc-500 mb-4">
              命令: <span className="text-zinc-800 font-medium">{killConfirm.comm}</span>
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setKillConfirm(null)} className="win-btn win-btn--sm">
                取消
              </button>
              <button type="button" onClick={() => handleKill(killConfirm)} className="win-btn win-btn--sm win-btn--danger">
                确认终止
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
