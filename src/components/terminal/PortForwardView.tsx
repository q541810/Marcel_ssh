import { useMemo, useRef, useState } from 'react';
import { Copy, ExternalLink, Globe, Pin, RefreshCw, X } from 'lucide-react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { usePortForward } from '@/hooks/usePortForward';
import { openExternalLink } from '@/lib/externalLinks';
import type { PortForwardInfo } from '@/lib/tauri';
import {
  forwardHealth,
  forwardUrl,
  isLoopbackTarget,
  mergeForwardRows,
  parseForwardTarget,
  type ForwardHealth,
  type ForwardRow,
} from '@/lib/portForward';

interface PortForwardViewProps {
  sessionId: string;
  /** 手机：按钮和行高放大到触摸尺寸。桌面底栏面板与手机 Sheet 共用这一个视图。 */
  touch?: boolean;
}

const HEALTH_DOT: Record<ForwardHealth, string> = {
  ok: 'bg-emerald-400',
  offline: 'bg-amber-400',
  error: 'bg-red-400',
};

export default function PortForwardView({ sessionId, touch = false }: PortForwardViewProps) {
  const {
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
  } = usePortForward(sessionId);
  const [input, setInput] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  /** 正在改备注的行（`ForwardRow.key`）与草稿。 */
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  /** Esc 取消：输入框一卸载也会触发 blur，别让 blur 把取消掉的草稿又存回去。 */
  const cancelEdit = useRef(false);

  const rows = useMemo(
    () => mergeForwardRows(forwards, notes, services),
    [forwards, notes, services],
  );

  const offline = forwards.some((f) => !f.sessionOnline);
  const rowPad = touch ? 'py-2.5' : 'py-1.5';
  const btn = touch
    ? 'rounded-lg px-3 py-2 text-meta active:scale-95'
    : 'rounded-md px-2 py-1 text-meta';
  const iconBtn = `inline-flex items-center justify-center text-fg-secondary bg-surface-raised hover:bg-state-mid transition-colors ${
    touch ? 'h-9 w-9 rounded-lg active:scale-95' : 'h-6 w-6 rounded-md'
  }`;
  const iconSize = touch ? 'h-4 w-4' : 'h-3.5 w-3.5';
  const pinBtn = `inline-flex flex-shrink-0 items-center justify-center transition-colors ${
    touch ? 'h-9 w-9 rounded-lg active:scale-95' : 'h-6 w-6 rounded-md'
  }`;

  const submitManual = async () => {
    const target = parseForwardTarget(input);
    if (!target) {
      setInputError('请输入端口号（如 3000），或 地址:端口（如 10.0.0.5:3306）');
      return;
    }
    setInputError(null);
    const info = await start(target.host, target.port);
    if (info) setInput('');
  };

  const forwardAndMaybeOpen = async (host: string, port: number, open: boolean) => {
    const info = await start(host, port);
    if (info && open) openExternalLink(forwardUrl(info));
  };

  const copyAddress = async (forward: PortForwardInfo) => {
    await writeText(`127.0.0.1:${forward.localPort}`).catch(() => {});
    setCopiedId(forward.id);
    setTimeout(() => setCopiedId((id) => (id === forward.id ? null : id)), 1200);
  };

  const beginEditNote = (row: ForwardRow) => {
    cancelEdit.current = false;
    setEditingKey(row.key);
    setNoteDraft(row.note);
  };

  const commitNote = async (row: ForwardRow) => {
    if (cancelEdit.current) {
      cancelEdit.current = false;
      return;
    }
    setEditingKey(null);
    const next = noteDraft.trim();
    if (next === row.note.trim()) return;
    await setNote(row.remoteHost, row.remotePort, next, row.pinned);
  };

  const togglePin = async (row: ForwardRow) => {
    // 正在改这条的备注时，图钉要连刚输入的备注一起提交（点在别处会先触发 blur 保存，
    // 这里 preventDefault 保住焦点，避免两次写入打架）。
    if (editingKey === row.key) {
      const next = noteDraft.trim();
      setEditingKey(null);
      await setNote(row.remoteHost, row.remotePort, next, !row.pinned);
      return;
    }
    await setNote(row.remoteHost, row.remotePort, row.note, !row.pinned);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-shrink-0 border-b border-edge-subtle px-3 py-2">
        <div className="flex items-center gap-2">
          <input
            type="text"
            inputMode="text"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setInputError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitManual();
            }}
            placeholder="服务器端口，如 3000（或 地址:端口）"
            className={`min-w-0 flex-1 rounded-md field px-2 text-fg ${
              touch ? 'py-2 text-read' : 'py-1 text-meta'
            }`}
          />
          <button
            type="button"
            onClick={() => void submitManual()}
            className={`${btn} flex-shrink-0 bg-indigo-500/90 font-medium text-white transition-colors hover:bg-indigo-500`}
          >
            转发
          </button>
        </div>
        {(inputError || error) && (
          <div className="mt-1.5 text-meta text-red-300">{inputError ?? error}</div>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        {offline && (
          <div className="mx-3 mt-2 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-meta text-amber-300">
            会话已断开。重新连接后，下面的转发会自动恢复，不用重开。
          </div>
        )}

        <section className="px-3 pb-3 pt-3">
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-caption font-medium text-fg-tertiary">端口转发</h3>
            <button
              type="button"
              onClick={() => void scan()}
              disabled={scanning}
              className="inline-flex items-center gap-1 text-caption text-fg-secondary hover:text-fg disabled:opacity-40"
            >
              <RefreshCw className={`h-3 w-3 ${scanning ? 'animate-spin' : ''}`} />
              {scanning ? '读取中…' : '刷新'}
            </button>
          </div>
          {rows.length === 0 && !scanning ? (
            <p className="py-4 text-center text-meta text-fg-tertiary">
              没读到监听中的服务。
              <br />
              转发能把服务器上只对本机开放的网页、数据库映射到你电脑的 127.0.0.1 来访问。
            </p>
          ) : (
            <ul>
              {rows.map((row) => {
                const forward = row.forward;
                const editing = editingKey === row.key;
                // 记住的条目（没开转发）才提示「服务器上没这个服务」：正在转发的由 lastError 说明原因。
                const missing =
                  !forward &&
                  sessionConnected &&
                  isLoopbackTarget(row.remoteHost) &&
                  scanned &&
                  !row.listeningOnServer;
                return (
                  <li key={row.key} className={`border-b border-edge-subtle/50 ${rowPad}`}>
                    <div className="flex items-center gap-2">
                      {canRemember && (
                        <button
                          type="button"
                          onClick={() => void togglePin(row)}
                          onMouseDown={(e) => e.preventDefault()}
                          className={`${pinBtn} ${
                            row.pinned
                              ? 'text-indigo-300 hover:bg-indigo-500/15'
                              : 'text-fg-tertiary hover:bg-state-mid hover:text-fg-secondary'
                          }`}
                          aria-label={row.pinned ? '取消置顶' : '置顶'}
                          title={row.pinned ? '取消置顶' : '置顶'}
                          aria-pressed={row.pinned}
                        >
                          <Pin className={`${iconSize} ${row.pinned ? 'fill-current' : ''}`} />
                        </button>
                      )}
                      <span
                        className={`h-2 w-2 flex-shrink-0 rounded-full ${
                          forward
                            ? HEALTH_DOT[forwardHealth(forward)]
                            : row.listeningOnServer
                              ? 'bg-emerald-400/60'
                              : 'bg-fg-tertiary/40'
                        }`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono text-meta text-fg">
                          {forward && (
                            <>
                              127.0.0.1:{forward.localPort}
                              <span className="text-fg-tertiary"> → </span>
                            </>
                          )}
                          {isLoopbackTarget(row.remoteHost) ? null : `${row.remoteHost}:`}
                          {row.remotePort}
                          {row.process && (
                            <span className="ml-2 font-sans text-fg-tertiary">{row.process}</span>
                          )}
                        </div>
                        {editing ? (
                          <input
                            type="text"
                            value={noteDraft}
                            autoFocus
                            onChange={(e) => setNoteDraft(e.target.value)}
                            onBlur={() => void commitNote(row)}
                            onKeyDown={(e) => {
                              if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                              if (e.key === 'Enter') {
                                e.currentTarget.blur();
                              } else if (e.key === 'Escape') {
                                cancelEdit.current = true;
                                setEditingKey(null);
                              }
                            }}
                            placeholder="备注，比如：后台管理"
                            className="mt-1 w-full rounded-md field px-2 py-1 text-caption text-fg"
                          />
                        ) : row.note ? (
                          <button
                            type="button"
                            onClick={() => (canRemember ? beginEditNote(row) : undefined)}
                            className={`block max-w-full truncate text-left text-caption ${
                              canRemember ? 'text-fg-secondary hover:text-fg' : 'text-fg-secondary'
                            }`}
                            title={row.note}
                          >
                            {row.note}
                          </button>
                        ) : canRemember ? (
                          <button
                            type="button"
                            onClick={() => beginEditNote(row)}
                            className="text-caption text-fg-tertiary/70 hover:text-fg-secondary"
                          >
                            添加备注
                          </button>
                        ) : null}
                        <div className="text-caption text-fg-tertiary">
                          {forward
                            ? forward.activeConnections > 0
                              ? `${forward.activeConnections} 个连接中`
                              : forward.totalConnections > 0
                                ? `已处理 ${forward.totalConnections} 个连接`
                                : '等待访问'
                            : '未转发'}
                          {missing && (
                            <span className="text-amber-300/90"> · 服务器上暂未发现在监听</span>
                          )}
                        </div>
                      </div>
                      {forward ? (
                        <>
                          <button
                            type="button"
                            onClick={() => openExternalLink(forwardUrl(forward))}
                            className={`${btn} inline-flex flex-shrink-0 items-center gap-1 bg-indigo-500/10 font-medium text-indigo-300 transition-colors hover:bg-indigo-500/20`}
                          >
                            <ExternalLink className={iconSize} />
                            打开
                          </button>
                          <button
                            type="button"
                            onClick={() => void copyAddress(forward)}
                            className={iconBtn}
                            aria-label="复制本机地址"
                            title={copiedId === forward.id ? '已复制' : '复制本机地址'}
                          >
                            <Copy className={iconSize} />
                          </button>
                          <button
                            type="button"
                            onClick={() => void stop(forward.id)}
                            className={iconBtn}
                            aria-label="停止转发"
                            title="停止转发"
                          >
                            <X className={iconSize} />
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => void forwardAndMaybeOpen(row.remoteHost, row.remotePort, false)}
                            className={`${btn} flex-shrink-0 bg-fill font-medium text-fg transition-colors hover:bg-fill-strong`}
                          >
                            转发
                          </button>
                          {row.listeningOnServer && (
                            <button
                              type="button"
                              onClick={() => void forwardAndMaybeOpen(row.remoteHost, row.remotePort, true)}
                              className={`${btn} inline-flex flex-shrink-0 items-center gap-1 bg-indigo-500/10 text-indigo-300 transition-colors hover:bg-indigo-500/20`}
                              title="转发并在浏览器打开"
                            >
                              <Globe className={iconSize} />
                              转发并打开
                            </button>
                          )}
                        </>
                      )}
                    </div>
                    {forward?.lastError && (
                      <div className="mt-1 pl-4 text-caption text-red-300">{forward.lastError}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}