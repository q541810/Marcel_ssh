import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ShieldAlert, Terminal, Globe } from 'lucide-react';

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
import { CodeBlock, CopyButton, StatusPill } from './mcpServerParts';

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
        <SettingItem fullWidth
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
            <div className="flex items-center gap-2 text-meta text-fg-tertiary">
              <Terminal className="w-3.5 h-3.5" />
              粘贴到客户端的 MCP 配置里
            </div>
            {config?.stdio ? (
              <CodeBlock code={config.stdio} />
            ) : (
              <div className="text-meta text-fg-disabled">正在读取配置…</div>
            )}
          </div>
        </SettingItem>

        <SettingItem fullWidth
          id="mcp-external-agent-trust"
          label="它能做什么"
          description="外部 Agent 可以执行命令、收发文件，命令不经过 Marcel SSH 的风险评估，也不会弹审批。"
          sectionId="settings-mcp-server"
          keywords={['安全', '权限', '审批', '风险', 'trust', 'security']}
        >
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
            <ShieldAlert className="w-4 h-4 text-amber-400 flex-shrink-0 mt-1" />
            <p className="text-meta leading-5 text-amber-200/90">
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

        <SettingItem fullWidth
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
                className="w-40 rounded-lg bg-field border border-edge-strong px-3 py-2 text-body text-fg font-mono focus:outline-none focus:border-indigo-500 disabled:opacity-50"
              />
              <span className="text-fg-disabled text-body">:</span>
              <input
                value={String(port)}
                onChange={(e) => setPort(sanitizePortInput(e.target.value))}
                disabled={running || busy}
                inputMode="numeric"
                aria-label="端口"
                className="w-24 rounded-lg bg-field border border-edge-strong px-3 py-2 text-body text-fg font-mono focus:outline-none focus:border-indigo-500 disabled:opacity-50"
              />
            </div>
            {exposureWarning && (
              <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3">
                <ShieldAlert className="w-3.5 h-3.5 text-red-400 flex-shrink-0 mt-1" />
                <p className="text-caption leading-5 text-red-200/90">
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
              className="flex-1 min-w-0 rounded-lg bg-field border border-edge-strong px-3 py-2 text-meta text-fg-secondary font-mono focus:outline-none focus:border-indigo-500 read-only:opacity-70"
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
          <SettingItem fullWidth
            id="mcp-http-client-config"
            label="客户端配置"
            description="粘到支持 HTTP 的客户端里即可。"
            sectionId="settings-mcp-server"
            keywords={['http 配置', 'url', '端点', 'endpoint']}
          >
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-meta text-fg-tertiary">
                <Globe className="w-3.5 h-3.5" />
                {status!.url}
              </div>
              <CodeBlock code={config.http} />
            </div>
          </SettingItem>
        )}

        {error && (
          <SettingItem fullWidth
            id="mcp-http-error"
            label="出错了"
            sectionId="settings-mcp-server"
            keywords={['错误', 'error']}
          >
            <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-meta leading-5 text-red-200/90">
              {error}
            </div>
          </SettingItem>
        )}
      </Card>
    </div>
  );
}
