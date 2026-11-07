import { useState } from 'react';
import { Copy, ExternalLink, Globe, RefreshCw, X } from 'lucide-react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { usePortForward } from '@/hooks/usePortForward';
import { openExternalLink } from '@/lib/externalLinks';
import type { PortForwardInfo } from '@/lib/tauri';
import {
  findForward,
  forwardHealth,
  forwardUrl,
  parseForwardTarget,
  type ForwardHealth,
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
  const { forwards, services, scanning, error, scan, start, stop } = usePortForward(sessionId);
  const [input, setInput] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const offline = forwards.some((f) => !f.sessionOnline);
  const rowPad = touch ? 'py-2.5' : 'py-1.5';
  const btn = touch
    ? 'rounded-lg px-3 py-2 text-meta active:scale-95'
    : 'rounded-md px-2 py-1 text-meta';
  const iconBtn = `inline-flex items-center justify-center text-fg-secondary bg-surface-raised hover:bg-state-mid transition-colors ${
    touch ? 'h-9 w-9 rounded-lg active:scale-95' : 'h-6 w-6 rounded-md'
  }`;
  const iconSize = touch ? 'h-4 w-4' : 'h-3.5 w-3.5';

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

        {forwards.length > 0 && (
          <section className="px-3 pt-3">
            <h3 className="mb-1 text-caption font-medium text-fg-tertiary">已转发到本机</h3>
            <ul>
              {forwards.map((f) => {
                const health = forwardHealth(f);
                const known = services.find((s) => s.port === f.remotePort);
                return (
                  <li key={f.id} className={`border-b border-edge-subtle/50 ${rowPad}`}>
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 flex-shrink-0 rounded-full ${HEALTH_DOT[health]}`} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono text-meta text-fg">
                          127.0.0.1:{f.localPort}
                          <span className="text-fg-tertiary"> → </span>
                          {f.remoteHost === 'localhost' ? '' : `${f.remoteHost}:`}
                          {f.remotePort}
                          {known?.process && (
                            <span className="ml-2 font-sans text-fg-tertiary">{known.process}</span>
                          )}
                        </div>
                        <div className="text-caption text-fg-tertiary">
                          {f.activeConnections > 0
                            ? `${f.activeConnections} 个连接中`
                            : f.totalConnections > 0
                              ? `已处理 ${f.totalConnections} 个连接`
                              : '等待访问'}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => openExternalLink(forwardUrl(f))}
                        className={`${btn} inline-flex flex-shrink-0 items-center gap-1 bg-indigo-500/10 font-medium text-indigo-300 transition-colors hover:bg-indigo-500/20`}
                      >
                        <ExternalLink className={iconSize} />
                        打开
                      </button>
                      <button
                        type="button"
                        onClick={() => void copyAddress(f)}
                        className={iconBtn}
                        aria-label="复制本机地址"
                        title={copiedId === f.id ? '已复制' : '复制本机地址'}
                      >
                        <Copy className={iconSize} />
                      </button>
                      <button
                        type="button"
                        onClick={() => void stop(f.id)}
                        className={iconBtn}
                        aria-label="停止转发"
                        title="停止转发"
                      >
                        <X className={iconSize} />
                      </button>
                    </div>
                    {f.lastError && (
                      <div className="mt-1 pl-4 text-caption text-red-300">{f.lastError}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section className="px-3 pb-3 pt-3">
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-caption font-medium text-fg-tertiary">服务器上正在运行的服务</h3>
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
          {services.length === 0 && !scanning ? (
            <p className="py-4 text-center text-meta text-fg-tertiary">
              没读到监听中的服务。
              <br />
              转发能把服务器上只对本机开放的网页、数据库映射到你电脑的 127.0.0.1 来访问。
            </p>
          ) : (
            <ul>
              {services.map((s) => {
                const existing = findForward(forwards, s.targetHost, s.port);
                return (
                  <li
                    key={s.port}
                    className={`flex items-center gap-2 border-b border-edge-subtle/50 ${rowPad}`}
                  >
                    <div className="min-w-0 flex-1 truncate text-meta">
                      <span className="font-mono text-indigo-300">{s.port}</span>
                      {s.process && <span className="ml-2 text-fg-secondary">{s.process}</span>}
                      {s.targetHost !== 'localhost' && (
                        <span className="ml-2 font-mono text-caption text-fg-tertiary">{s.targetHost}</span>
                      )}
                    </div>
                    {existing ? (
                      <span className="flex-shrink-0 text-caption text-emerald-400">已转发</span>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => void forwardAndMaybeOpen(s.targetHost, s.port, false)}
                          className={`${btn} flex-shrink-0 bg-fill text-fg transition-colors hover:bg-fill-strong`}
                        >
                          转发
                        </button>
                        <button
                          type="button"
                          onClick={() => void forwardAndMaybeOpen(s.targetHost, s.port, true)}
                          className={`${btn} inline-flex flex-shrink-0 items-center gap-1 bg-indigo-500/10 text-indigo-300 transition-colors hover:bg-indigo-500/20`}
                          title="转发并在浏览器打开"
                        >
                          <Globe className={iconSize} />
                          转发并打开
                        </button>
                      </>
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
