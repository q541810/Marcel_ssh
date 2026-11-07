import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Globe, RefreshCw, ShieldAlert, Smartphone } from 'lucide-react';

import Button from '@/components/ui/Button';
import Toggle from '@/components/ui/Toggle';
import { useSettingsActions } from '@/components/settings/SettingsActionsContext';
import { CodeBlock, CopyButton, StatusPill } from '@/components/settings/mcpServerParts';
import { getErrorMessage } from '@/lib/errors';
import { isExposedBind, isValidPort, sanitizePortInput } from '@/lib/mcpServerUi';
import {
  mcpServerClientConfig,
  mcpServerDefaults,
  mcpServerRegenerateToken,
  mcpServerStartHttp,
  mcpServerStatus,
  mcpServerStopHttp,
} from '@/lib/tauri';
import type { McpClientConfig, McpHttpRuntimeInfo } from '@/lib/types';
import {
  holdForeground,
  isNotificationPermissionGranted,
  releaseForeground,
  requestNotificationPermission,
} from '../mobileBridge';
import { MobileSettingRow } from './MobileSettingRow';

/** 前台保活登记用的 key：同一个服务只占一份。 */
const HOLD_KEY = 'mcp-server';

/** 「局域网」对应的通配绑定地址：监听所有网卡。 */
const LAN_BIND = '0.0.0.0';
const LOCAL_BIND = '127.0.0.1';

function holdText(info: McpHttpRuntimeInfo): { title: string; body: string } {
  return { title: 'MCP 服务运行中', body: info.url };
}

/**
 * 手机端「MCP 服务」设置页：让手机上的其它程序（如 Termux 里的 agent）或局域网里的
 * 电脑，通过 HTTP 接入 Marcel SSH 已保存的连接。
 *
 * 只有 HTTP：stdio 是「客户端启动本进程」的模型，手机上没有这回事。
 * 和桌面共用同一组后端命令与同一套安全边界（Bearer 令牌、默认只绑回环），
 * 差别只在：手机进程会被系统回收，所以服务开着时要持有前台保活服务。
 *
 * 属于「纯功能」：只是已有命令的一层界面，不协调别的功能；保活登记在 mobileBridge。
 */
export function MobileMcpServerSection() {
  const { settings } = useSettingsActions();
  const keepAliveEnabled = settings.mobileBackgroundSettings.keepAliveEnabled;

  const [status, setStatus] = useState<McpHttpRuntimeInfo | null>(null);
  const [config, setConfig] = useState<McpClientConfig | null>(null);
  const [lan, setLan] = useState(false);
  const [port, setPort] = useState(8765);
  /** 停止状态下待用的令牌；启动后以后端返回的为准 */
  const [pendingToken, setPendingToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const running = status !== null;

  const refresh = useCallback(async () => {
    try {
      const [st, cfg] = await Promise.all([mcpServerStatus(), mcpServerClientConfig()]);
      setStatus(st);
      setConfig(cfg);
      if (st) {
        setLan(isExposedBind(st.bind));
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
        setPort(defaults.port);
      } catch {
        // 拿不到默认值就用组件里的兜底值，不打断使用
      }
      const st = await refresh();
      if (st) {
        // WebView 重载但进程还活着：服务在跑，保活登记却丢了，补上
        const { title, body } = holdText(st);
        holdForeground(HOLD_KEY, title, body);
      } else {
        try {
          setPendingToken(await mcpServerRegenerateToken());
        } catch {
          // 生成失败时留空，后端启动时会自动补一个
        }
      }
    })();
  }, [refresh]);

  const start = async () => {
    // 前台服务需要常驻通知；没权限时服务照开，但要如实告诉用户后台可能被回收
    let notificationDenied = false;
    if (!isNotificationPermissionGranted()) {
      notificationDenied = !(await requestNotificationPermission());
    }
    const info = await mcpServerStartHttp(lan ? LAN_BIND : LOCAL_BIND, port, pendingToken || undefined);
    const { title, body } = holdText(info);
    holdForeground(HOLD_KEY, title, body);
    if (notificationDenied) {
      setNotice('没有通知权限，常驻通知不会显示，切到后台时服务更容易被系统回收。可到系统设置里为 Marcel SSH 开启通知。');
    }
  };

  const stop = async () => {
    await mcpServerStopHttp();
    releaseForeground(HOLD_KEY, keepAliveEnabled);
  };

  const handleToggle = async (next: boolean) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (next) {
        await start();
      } else {
        await stop();
      }
      const st = await refresh();
      if (!st) {
        // 停止后预备下一次启动要用的新令牌
        setPendingToken(await mcpServerRegenerateToken().catch(() => ''));
      }
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

  const shownToken = running ? status.token : pendingToken;

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-800/60 bg-red-950/30 px-3 py-2">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-400" />
          <p className="flex-1 text-meta leading-relaxed text-red-300">{error}</p>
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-2">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" />
          <p className="flex-1 text-meta leading-relaxed text-amber-300/90">{notice}</p>
        </div>
      )}

      <MobileSettingRow
        label="启用 MCP 服务"
        description="让 Termux 里的 agent，或同一网络里的电脑，通过 HTTP 调用你在这里保存的连接。关闭时端口不监听。"
        trailing={
          <div className="flex items-center gap-3">
            <StatusPill running={running} />
            <Toggle
              checked={running}
              onChange={(v) => void handleToggle(v)}
              disabled={busy || (!running && !isValidPort(port))}
            />
          </div>
        }
      />

      <MobileSettingRow
        label="谁能连"
        description={running ? '运行中不可修改，先关闭服务再改。' : '默认只有这台手机上的程序能连。'}
      >
        <div className="mt-3 grid grid-cols-2 gap-1 rounded-xl bg-surface-sunken p-1">
          <ScopeButton
            active={!lan}
            disabled={running || busy}
            icon={<Smartphone className="h-4 w-4" />}
            label="仅本机"
            onClick={() => setLan(false)}
          />
          <ScopeButton
            active={lan}
            disabled={running || busy}
            icon={<Globe className="h-4 w-4" />}
            label="局域网"
            onClick={() => setLan(true)}
          />
        </div>
        {lan && (
          <div className="mt-2 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-2.5">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-red-400" />
            <p className="text-caption leading-5 text-red-200/90">
              同一 Wi-Fi 下任何拿到令牌的设备，都能在你已保存的服务器上执行
              <span className="font-medium">无审批</span>
              命令。只在可信网络里用，或走 Tailscale 之类的私有网络。
            </p>
          </div>
        )}
        <div className="mt-3 flex items-center gap-2">
          <span className="text-meta text-fg-tertiary">端口</span>
          <input
            value={String(port)}
            onChange={(e) => setPort(sanitizePortInput(e.target.value))}
            disabled={running || busy}
            inputMode="numeric"
            aria-label="端口"
            className="w-28 rounded-lg border border-edge bg-field px-3 py-2 font-mono text-body text-fg focus:border-indigo-500 focus:outline-none disabled:opacity-50"
          />
        </div>
      </MobileSettingRow>

      <MobileSettingRow
        label="访问令牌"
        description={
          running
            ? '客户端需在 Authorization 头里带它。换令牌会让已接入的客户端立刻断连，所以要改得先关服务。'
            : '启动时使用这个令牌；清空则自动生成。'
        }
      >
        <div className="mt-3 flex items-center gap-2">
          <input
            value={shownToken}
            readOnly={running}
            onChange={(e) => setPendingToken(e.target.value)}
            spellCheck={false}
            aria-label="访问令牌"
            placeholder="启动时自动生成"
            className="min-w-0 flex-1 rounded-lg border border-edge bg-field px-3 py-2 font-mono text-meta text-fg-secondary focus:border-indigo-500 focus:outline-none read-only:opacity-70"
          />
          {shownToken && <CopyButton text={shownToken} size="md" />}
        </div>
        {!running && (
          <Button variant="ghost" size="md" onClick={handleRegenerate} className="mt-2">
            <RefreshCw className="h-3.5 w-3.5" />
            重新生成
          </Button>
        )}
      </MobileSettingRow>

      {running && config?.http && (
        <MobileSettingRow
          label="客户端配置"
          description="粘到支持 HTTP 的 MCP 客户端里即可。"
        >
          <div className="mt-3 space-y-2">
            <div className="flex items-center gap-1.5 break-all font-mono text-caption text-fg-tertiary">
              <Globe className="h-3.5 w-3.5 flex-shrink-0" />
              {status.url}
            </div>
            <CodeBlock code={config.http} touch />
          </div>
        </MobileSettingRow>
      )}

      <div className="mt-2 flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3">
        <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" />
        <p className="text-meta leading-5 text-amber-200/90">
          外部 Agent 可以在你的服务器上执行命令、收发文件，这些命令
          <span className="font-medium">不经过风险评估，也不会弹审批</span>
          。只接你信任的 Agent。
        </p>
      </div>

      <div className="rounded-xl border border-edge-subtle bg-surface/50 p-3">
        <div className="mb-2 text-meta font-medium text-fg-secondary">在手机上用要知道</div>
        <ul className="space-y-1.5 text-meta leading-relaxed text-fg-tertiary">
          <li>· 服务开着时会启用前台服务（状态栏常驻通知），关掉服务后自动恢复。</li>
          <li>· 重启 App 后服务是关闭的，需要再打开；系统在极端情况下仍可能回收进程。</li>
          <li>· 手机上不提供文件上传/下载工具（本地路径指的是手机，Termux 等读不到），传文件请让 Agent 在远端用命令完成。</li>
        </ul>
      </div>
    </div>
  );
}

function ScopeButton({
  active,
  disabled,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg text-body font-medium transition-colors duration-100 disabled:opacity-60 ${
        active ? 'bg-zinc-700 text-fg' : 'text-fg-tertiary active:bg-state-soft'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
