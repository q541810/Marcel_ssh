import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, RefreshCw, ShieldAlert, Terminal, Globe } from 'lucide-react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

import Button from '@/components/ui/Button';
import Toggle from '@/components/ui/Toggle';
import { getErrorMessage } from '@/lib/errors';
import {
  mcpServerClientConfig,
  mcpServerDefaults,
  mcpServerRegenerateToken,
  mcpServerStartHttp,
  mcpServerStatus,
  mcpServerStopHttp,
} from '@/lib/tauri';
import type { McpClientConfig, McpHttpRuntimeInfo } from '@/lib/types';
import { isExposedBind, isValidPort, sanitizePortInput } from '@/lib/mcpServerUi';
import { Card, SettingItem } from './helpers';

/**
 * 复制按钮：按下即反馈。
 *
 * 用局部组件而不是每处重写，是因为「复制 → 短暂显示已复制」这个反馈
 * 必须处处一致——不一致的反馈比没有反馈更让人怀疑到底成没成。
 */
function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // 复制失败保持原样：不谎报成功
    }
  };

  return (
    <Button variant="secondary" size="sm" onClick={handleCopy} className="shrink-0">
      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
      {copied ? '已复制' : label}
    </Button>
  );
}

/**
 * 配置片段展示。
 *
 * monospace + 横向滚动：路径在 Windows 上很长，换行会让 JSON 看起来是坏的。
 * 复制按钮贴在代码块右上角，紧邻它复制的东西（控件靠近它影响的对象）。
 */
function CodeBlock({ code }: { code: string }) {
  return (
    <div className="relative rounded-lg bg-zinc-950 border border-zinc-800">
      <div className="absolute top-2 right-2">
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto p-3 pr-24 text-[11px] leading-5 font-mono text-zinc-300">
        {code}
      </pre>
    </div>
  );
}

/** 运行状态指示：一眼看出服务在不在跑。 */
function StatusPill({ running }: { running: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span
        className={`w-1.5 h-1.5 rounded-full ${running ? 'bg-emerald-400' : 'bg-zinc-600'}`}
        aria-hidden
      />
      <span className={running ? 'text-emerald-400' : 'text-zinc-500'}>
        {running ? '运行中' : '已停止'}
      </span>
    </span>
  );
}

export function McpServerSection() {
  const [status, setStatus] = useState<McpHttpRuntimeInfo | null>(null);
  const [config, setConfig] = useState<McpClientConfig | null>(null);
  const [bind, setBind] = useState('127.0.0.1');
  const [port, setPort] = useState(8765);
  /** 停止状态下待用的令牌；启动后由后端返回的为准 */
  const [pendingToken, setPendingToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const running = status !== null;

  const refresh = useCallback(async () => {
    try {
      const [st, cfg] = await Promise.all([mcpServerStatus(), mcpServerClientConfig()]);
      setStatus(st);
      setConfig(cfg);
      if (st) {
        setBind(st.bind);
        setPort(st.port);
      }
      return st;
    } catch (e) {
      setError(getErrorMessage(e));
      return null;
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const defaults = await mcpServerDefaults();
        setBind(defaults.bind);
        setPort(defaults.port);
      } catch {
        // 拿不到默认值就用组件里的兜底值，不打断使用
      }
      const st = await refresh();
      // 没在跑时预备一个令牌，用户点「启用」就能直接用
      if (!st) {
        try {
          setPendingToken(await mcpServerRegenerateToken());
        } catch {
          // 生成失败时留空，后端启动时会自动补一个
        }
      }
    })();
  }, [refresh]);

  const handleToggle = async (next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (next) {
        await mcpServerStartHttp(bind, port, pendingToken || undefined);
      } else {
        await mcpServerStopHttp();
      }
      await refresh();
    } catch (e) {
      // 端口占用等失败原因由后端翻译成人话，直接展示
      setError(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const handleRegenerate = async () => {
    setError(null);
    try {
      setPendingToken(await mcpServerRegenerateToken());
    } catch (e) {
      setError(getErrorMessage(e));
    }
  };

  const exposureWarning = isExposedBind(bind);
  const shownToken = running ? status.token : pendingToken;

  return (
    <div className="space-y-6">
      {/* ── 方式一：stdio ── */}
      <Card
        id="settings-mcp-server"
        title="让外部 Agent 接入 Marcel SSH"
        description="Claude Code、zcode、DeepSeek Harness 等可以调用你已保存的连接执行 SSH / SFTP 操作"
      >
        <SettingItem
          id="mcp-client-config-stdio"
          label="方式一：stdio（推荐）"
          description="客户端自己启动 Marcel SSH，不需要保持任何东西在后台运行。你在界面上保存的连接会自动可用。"
          sectionId="settings-mcp-server"
          keywords={[
            'mcp', 'agent', 'claude code', 'zcode', 'dsh', 'deepseek',
            'stdio', '接入', '外部 agent', '子 agent', 'subagent',
          ]}
        >
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
              <Terminal className="w-3.5 h-3.5" />
              粘贴到客户端的 MCP 配置里
            </div>
            {config ? (
              <CodeBlock code={config.stdio} />
            ) : (
              <div className="text-xs text-zinc-600">正在读取配置…</div>
            )}
          </div>
        </SettingItem>

        <SettingItem
          id="mcp-external-agent-trust"
          label="它能做什么"
          description="外部 Agent 可以执行命令、收发文件，命令不经过 Marcel SSH 的风险评估，也不会弹审批。"
          sectionId="settings-mcp-server"
          keywords={['安全', '权限', '审批', '风险', 'trust', 'security']}
        >
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
            <ShieldAlert className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs leading-5 text-amber-200/90">
              这是刻意的设计——「是你把这个 Agent 接进来的」。所以
              <span className="font-medium">只接你信任的 Agent</span>
              ，并且不要把它暴露给不可信的人。
            </p>
          </div>
        </SettingItem>
      </Card>

      {/* ── 方式二：HTTP ── */}
      <Card
        title="方式二：HTTP 常驻服务"
        description="让 Marcel SSH 开一个本机端口等客户端来连。适合需要常驻服务或多个客户端同时接入的情况"
      >
        <SettingItem
          id="mcp-http-enabled"
          label="启用"
          description="关闭时端口不监听，已保存的连接也不受影响。"
          sectionId="settings-mcp-server"
          keywords={['http', '常驻', '端口', '服务', 'enable', 'server']}
        >
          <div className="flex items-center gap-3">
            <Toggle
              checked={running}
              onChange={handleToggle}
              disabled={busy || (!running && !isValidPort(port))}
            />
            <StatusPill running={running} />
          </div>
        </SettingItem>

        <SettingItem
          id="mcp-http-endpoint"
          label="监听地址"
          description={
            running
              ? '运行中不可修改，先停止服务再改。'
              : '默认只监听本机。改成别的地址会让局域网内其他机器也能连上。'
          }
          sectionId="settings-mcp-server"
          keywords={['bind', '地址', '端口', 'port', '监听', 'localhost']}
        >
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <input
                value={bind}
                onChange={(e) => setBind(e.target.value)}
                disabled={running || busy}
                aria-label="监听地址"
                placeholder="127.0.0.1"
                spellCheck={false}
                className="w-40 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 font-mono focus:outline-none focus:border-indigo-500 disabled:opacity-50"
              />
              <span className="text-zinc-600 text-sm">:</span>
              <input
                value={String(port)}
                onChange={(e) => setPort(sanitizePortInput(e.target.value))}
                disabled={running || busy}
                inputMode="numeric"
                aria-label="端口"
                className="w-24 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 font-mono focus:outline-none focus:border-indigo-500 disabled:opacity-50"
              />
            </div>
            {exposureWarning && (
              <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-2.5">
                <ShieldAlert className="w-3.5 h-3.5 text-red-400 flex-shrink-0 mt-0.5" />
                <p className="text-[11px] leading-5 text-red-200/90">
                  <span className="font-medium">{bind}</span> 不是本机地址：局域网内任何能访问
                  这个端口的程序，都能在你已保存的服务器上执行<span className="font-medium">无审批</span>
                  命令。真要用，请走 SSH 隧道或 Tailscale 之类的私有网络，不要直接暴露。
                </p>
              </div>
            )}
          </div>
        </SettingItem>

        <SettingItem
          id="mcp-http-token"
          label="访问令牌"
          description={
            running
              ? '客户端需在 Authorization 头里带它。换令牌会让已接入的客户端立刻断连，所以要改得先停服务。'
              : '启动时会用这个令牌；留空则自动生成一个。'
          }
          sectionId="settings-mcp-server"
          keywords={['token', '令牌', '密钥', '认证', 'auth', 'bearer', 'api key']}
        >
          <div className="flex items-center gap-2">
            <input
              value={shownToken}
              readOnly={running}
              spellCheck={false}
              aria-label="访问令牌"
              onChange={(e) => setPendingToken(e.target.value)}
              placeholder="启动时自动生成"
              className="flex-1 min-w-0 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 font-mono focus:outline-none focus:border-indigo-500 read-only:opacity-70"
            />
            {shownToken && <CopyButton text={shownToken} />}
            {!running && (
              <Button variant="ghost" size="sm" onClick={handleRegenerate} className="shrink-0">
                <RefreshCw className="w-3.5 h-3.5" />
                重新生成
              </Button>
            )}
          </div>
        </SettingItem>

        {running && config?.http && (
          <SettingItem
            id="mcp-http-client-config"
            label="客户端配置"
            description="粘到支持 HTTP 的客户端里即可。"
            sectionId="settings-mcp-server"
            keywords={['http 配置', 'url', '端点', 'endpoint']}
          >
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                <Globe className="w-3.5 h-3.5" />
                {status!.url}
              </div>
              <CodeBlock code={config.http} />
            </div>
          </SettingItem>
        )}

        {error && (
          <SettingItem
            id="mcp-http-error"
            label="出错了"
            sectionId="settings-mcp-server"
            keywords={['错误', 'error']}
          >
            <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs leading-5 text-red-200/90">
              {error}
            </div>
          </SettingItem>
        )}
      </Card>
    </div>
  );
}
