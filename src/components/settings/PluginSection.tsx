import { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, Puzzle, Eye, Wrench, Shield, FolderOpen, Check, Settings, Syringe, AlertCircle, RotateCw } from 'lucide-react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { getPluginDir, openPluginDir } from '@/lib/tauri';
import { usePluginStore } from '@/stores/pluginStore';
import type { PluginManifest } from '@/lib/types';
import { getInjectionStatuses, onStatusChange, retryInjection, type InjectionStatus } from '@/plugins/injection';
import Toggle from '@/components/ui/Toggle';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import { useSettingsActions } from './SettingsActionsContext';
import { Card, SettingItem } from './helpers';
import PluginConfigModal from './PluginConfigModal';

const CAPABILITY_LABELS: Record<string, string> = {
  'ssh.list': '查询 SSH 会话与连接信息',
  'ssh.exec': '执行远程命令',
  'sftp.read': '读取远程文件',
  'sftp.write': '写入远程文件',
  'fs.read': '读取本地文件',
  'fs.write': '写入本地文件',
  'net.request': '发起网络请求',
  'notification': '发送通知',
  'events': '订阅应用事件',
  'ui.inject': '注入主界面（JS/CSS）',
};

const MOUNT_LABELS: Record<string, string> = {
  sidebar: '左侧面板',
  center: '中央面板',
  bottom: '底部面板',
  agent: '右侧面板',
};

/** Subscribe to injection status changes from the engine and re-render on
 *  any change (activation, deactivation, error, retry). */
function useInjectionStatuses(): InjectionStatus[] {
  const [statuses, setStatuses] = useState<InjectionStatus[]>(() => getInjectionStatuses());
  useEffect(() => {
    const update = () => setStatuses(getInjectionStatuses());
    update();
    return onStatusChange(update);
  }, []);
  return statuses;
}

/** Inline display of one plugin's content-script injections: per-injection
 *  active/error state + retry button. Shown only when the manifest declares
 *  injections. */
function InjectionDetail({
  manifest,
  status,
}: {
  manifest: PluginManifest;
  status?: InjectionStatus;
}) {
  const injectionCount = manifest.injections.length;
  if (injectionCount === 0) return null;

  // Build a lookup by local id so we can show active/error per declared injection.
  const statusById = new Map((status?.injections ?? []).map((i) => [i.id, i]));
  const anyError = (status?.injections ?? []).some((i) => i.error);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs text-zinc-500">
        <Syringe className="w-3.5 h-3.5" />
        <span>{injectionCount} 个注入</span>
        {anyError && (
          <span className="inline-flex items-center gap-1 text-red-400">
            <AlertCircle className="w-3 h-3" />
            有错误
          </span>
        )}
      </div>
      {manifest.injections.map((inj) => {
        const st = statusById.get(inj.id);
        const err = st?.error;
        return (
          <div
            key={inj.id}
            className="rounded-md bg-zinc-800/60 px-2 py-1.5 text-[11px] text-zinc-400"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-mono">{inj.id}</span>
              <span className={st?.active && !err ? 'text-emerald-400' : err ? 'text-red-400' : 'text-zinc-500'}>
                {st?.active && !err ? '运行中' : err ? '错误' : '未激活'}
              </span>
            </div>
            <div className="text-zinc-600 mt-0.5">
              {inj.styles.length} CSS / {inj.scripts.length} JS · targets: {inj.matches.join(', ') || '*'}
            </div>
            {err && (
              <div className="mt-1.5 space-y-1">
                <pre className="whitespace-pre-wrap break-all text-red-400 font-mono text-[10px] max-h-24 overflow-y-auto">
                  {err}
                </pre>
                <button
                  type="button"
                  onClick={() => {
                    retryInjection(manifest, inj.id).catch((e) => {
                      console.error('retry injection failed:', e);
                    });
                  }}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-700 text-zinc-200 hover:bg-zinc-600 transition-colors"
                >
                  <RotateCw className="w-3 h-3" />
                  重试
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function CapabilityManager({ pluginId, declared }: { pluginId: string; declared: string[] }) {
  const { settings, update } = useSettingsActions();
  const authorizedMap = settings.authorizedCapabilities ?? {};
  const authorizedList = authorizedMap[pluginId];

  const isAuthorized = (cap: string) => {
    if (!authorizedList) return declared.includes(cap);
    return authorizedList.includes(cap);
  };

  const toggleCapability = (cap: string) => {
    const current = authorizedList ?? [...declared];
    const next = current.includes(cap)
      ? current.filter((c) => c !== cap)
      : [...current, cap];

    const allAuthorized = declared.every((c) => next.includes(c)) && next.length >= declared.length;
    const newMap = { ...authorizedMap };
    if (allAuthorized) {
      delete newMap[pluginId];
    } else {
      newMap[pluginId] = next;
    }
    update({ authorizedCapabilities: newMap });
  };

  return (
    <div className="space-y-2">
      {declared.map((cap) => (
        <div key={cap} className="flex items-center justify-between py-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm text-zinc-300">
              {CAPABILITY_LABELS[cap] ?? cap}
            </span>
            {CAPABILITY_LABELS[cap] && (
              <code className="text-[11px] text-zinc-600 bg-zinc-800 px-1.5 py-0.5 rounded flex-shrink-0">{cap}</code>
            )}
          </div>
          <Toggle
            checked={isAuthorized(cap)}
            onChange={() => toggleCapability(cap)}
            size="sm"
          />
        </div>
      ))}
    </div>
  );
}

function PluginCard({ manifest, injectionStatus }: { manifest: PluginManifest; injectionStatus?: InjectionStatus }) {
  const { settings, update } = useSettingsActions();
  const disabledSet = new Set(settings.disabledPlugins ?? []);
  const isDisabled = disabledSet.has(manifest.id);
  const [showCapabilities, setShowCapabilities] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [showRestartHint, setShowRestartHint] = useState(false);

  const togglePlugin = () => {
    const current = settings.disabledPlugins ?? [];
    const next = isDisabled
      ? current.filter((id) => id !== manifest.id)
      : [...current, manifest.id];
    update({ disabledPlugins: next });

    // 禁用插件后提示：插件创建的独立窗口在禁用后不会自动关闭，
    // 重启是最简单可靠的清理方式。不检查插件是否有窗口——
    // 禁用是低频操作，多一次确认不影响体验。
    if (!isDisabled) {
      setShowRestartHint(true);
    }
  };

  const viewCount = manifest.views.length;
  const toolCount = manifest.agentTools.length;
  const capCount = manifest.capabilities.length;
  const hasConfigView = !!manifest.configView;
  const injectionCount = manifest.injections.length;

  return (
    <>
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
          <div className="flex items-center gap-3 min-w-0">
            <Puzzle className="w-5 h-5 text-zinc-500 flex-shrink-0" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-zinc-100 truncate">{manifest.name}</span>
                <span className="text-[11px] text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded flex-shrink-0">v{manifest.version}</span>
              </div>
              {manifest.publisher && (
                <div className="text-xs text-zinc-500 mt-0.5">{manifest.publisher}</div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={!hasConfigView}
              onClick={() => hasConfigView && setConfigOpen(true)}
              title={hasConfigView ? '打开配置界面' : '此插件未提供配置界面'}
            >
              <Settings className="w-3.5 h-3.5" />
              配置
            </Button>
            <Toggle
              checked={!isDisabled}
              onChange={togglePlugin}
            />
          </div>
        </div>

      {/* Description */}
      {manifest.description && (
        <div className="px-5 py-3 border-b border-zinc-800">
          <p className="text-sm text-zinc-400 leading-relaxed">{manifest.description}</p>
        </div>
      )}

      {/* Capabilities summary */}
      <div className="px-5 py-3 space-y-3">
        <div className="flex items-center gap-4 text-xs text-zinc-500">
          {viewCount > 0 && (
            <div className="flex items-center gap-1.5">
              <Eye className="w-3.5 h-3.5" />
              <span>{viewCount} 个视图</span>
            </div>
          )}
          {toolCount > 0 && (
            <div className="flex items-center gap-1.5">
              <Wrench className="w-3.5 h-3.5" />
              <span>{toolCount} 个工具</span>
            </div>
          )}
          {capCount > 0 && (
            <div className="flex items-center gap-1.5">
              <Shield className="w-3.5 h-3.5" />
              <span>{capCount} 个权限</span>
            </div>
          )}
          {injectionCount > 0 && (
            <div className="flex items-center gap-1.5">
              <Syringe className="w-3.5 h-3.5" />
              <span>{injectionCount} 个注入</span>
            </div>
          )}
        </div>

        {/* Views detail */}
        {viewCount > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {manifest.views.map((v) => (
              <span
                key={v.id}
                className="inline-flex items-center gap-1 text-[11px] text-zinc-400 bg-zinc-800 px-2 py-0.5 rounded-full"
              >
                {MOUNT_LABELS[v.mount] ?? v.mount}：{v.title}
              </span>
            ))}
          </div>
        )}

        {/* Agent tools detail */}
        {toolCount > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {manifest.agentTools.map((t) => (
              <span
                key={t.name}
                className="inline-flex items-center gap-1 text-[11px] text-zinc-400 bg-zinc-800 px-2 py-0.5 rounded-full"
              >
                <Wrench className="w-3 h-3" />
                {t.name}
              </span>
            ))}
          </div>
        )}

        {/* Injection detail */}
        <InjectionDetail manifest={manifest} status={injectionStatus} />

        {/* Capability management */}
        {capCount > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setShowCapabilities(!showCapabilities)}
              className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              {showCapabilities
                ? <ChevronDown className="w-3.5 h-3.5" />
                : <ChevronRight className="w-3.5 h-3.5" />}
              管理权限
            </button>
            {showCapabilities && (
              <div className="mt-2 pl-1">
                <CapabilityManager pluginId={manifest.id} declared={manifest.capabilities} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>

    {hasConfigView && (
      <PluginConfigModal
        open={configOpen}
        onClose={() => setConfigOpen(false)}
        pluginId={manifest.id}
        pluginName={manifest.name}
        configView={manifest.configView!}
      />
    )}

    <Modal
      open={showRestartHint}
      onClose={() => setShowRestartHint(false)}
      title="重启提示"
      size="sm"
    >
      <div className="px-4 py-3 text-sm text-zinc-300">
        <p>某些插件禁用后窗口不会完全关闭，重启应用可以解决。</p>
      </div>
      <div className="flex justify-end px-4 py-3 border-t border-zinc-700">
        <Button
          variant="primary"
          size="sm"
          onClick={() => setShowRestartHint(false)}
        >
          知道了
        </Button>
      </div>
    </Modal>
    </>
  );
}

export function PluginSection() {
  const manifests = usePluginStore((s) => s.manifests);
  const loading = usePluginStore((s) => s.loading);
  const error = usePluginStore((s) => s.error);
  const fetchPlugins = usePluginStore((s) => s.fetchPlugins);
  const [pluginDir, setPluginDir] = useState('');
  const [copied, setCopied] = useState(false);

  const injectionStatuses = useInjectionStatuses();
  const statusByPlugin = new Map(injectionStatuses.map((s) => [s.pluginId, s]));

  // Safe-mode toggle (disableAllInjections) lives in settings via the shared
  // SettingsActionsContext, same as other settings.
  const { settings, update } = useSettingsActions();
  const safeModeOn = settings.disableAllInjections ?? false;

  useEffect(() => {
    getPluginDir().then(setPluginDir);
  }, []);

  const handleCopy = async () => {
    await writeText(pluginDir);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="space-y-6">
      {/* Plugin directory + refresh + safe mode */}
      <Card id="settings-plugins" title="插件" description="管理本地安装的插件与主界面注入">
        <SettingItem
          id="plugins-directory"
          label="插件目录"
          description="将插件放入此目录后点击刷新即可发现"
          sectionId="settings-plugins"
          keywords={['plugin', 'directory', 'path', '插件', '目录']}
        >
          <div className="flex items-center gap-2 min-w-0">
            <span
              className="text-xs text-zinc-500 font-mono cursor-pointer hover:text-zinc-300 transition-colors select-all"
              title="点击复制路径"
              onClick={handleCopy}
            >
              {copied ? (
                <span className="inline-flex items-center gap-1 text-emerald-400">
                  <Check className="w-3 h-3" />
                  已复制
                </span>
              ) : (
                pluginDir
              )}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => openPluginDir()}
              title="打开目录"
            >
              <FolderOpen className="w-3.5 h-3.5" />
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={loading}
              onClick={() => fetchPlugins()}
            >
              刷新
            </Button>
          </div>
        </SettingItem>

        <SettingItem
          id="plugins-safe-mode"
          label="注入安全模式"
          description="开启后跳过所有插件内容脚本注入。插件 JS 卡死主界面时用此开关自救，重启后生效。"
          sectionId="settings-plugins"
          keywords={['safe', 'mode', 'injection', '安全模式', '注入', 'disable']}
        >
          <Toggle
            checked={safeModeOn}
            onChange={() => update({ disableAllInjections: !safeModeOn })}
          />
        </SettingItem>
      </Card>

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-5 py-4 text-sm text-red-400">
          加载失败：{error}
        </div>
      )}

      {/* Plugin cards */}
      {!loading && !error && manifests.length === 0 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-6 py-12 text-center">
          <Puzzle className="w-8 h-8 text-zinc-700 mx-auto mb-3" />
          <p className="text-sm text-zinc-500">暂无已安装插件</p>
          <p className="text-xs text-zinc-600 mt-1">将插件放入上方目录后点击刷新</p>
        </div>
      )}

      {!loading && !error && manifests.map((m) => (
        <PluginCard key={m.id} manifest={m} injectionStatus={statusByPlugin.get(m.id)} />
      ))}

    </div>
  );
}
