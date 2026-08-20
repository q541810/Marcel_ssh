import { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronRight, Puzzle, Eye, Wrench, Shield, FolderOpen, Check, Settings, Syringe, AlertCircle, RotateCw, Trash2, ArrowUpCircle } from 'lucide-react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { listen } from '@tauri-apps/api/event';
import { getPluginDir, openPluginDir, pluginUninstall, pluginUpdate, pluginInstallCancel } from '@/lib/tauri';
import { usePluginStore } from '@/stores/pluginStore';
import { useMarketStore } from '@/stores/marketStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { PluginManifest } from '@/lib/types';
import { satisfiesMinVersion } from '@/lib/semver';
import { capabilityLabel } from '@/lib/pluginCapabilities';
import { getErrorMessage, parseAppError } from '@/lib/errors';
import { useAppVersion } from '@/hooks/useAppVersion';
import { getInjectionStatuses, onStatusChange, retryInjection, type InjectionStatus } from '@/plugins/injection';
import Toggle from '@/components/ui/Toggle';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import InstallOverlay, { type InstallOverlayStatus, type InstallOverlayProgress } from '@/components/market/InstallOverlay';
import { useSettingsActions } from './SettingsActionsContext';
import { Card, SettingItem } from './helpers';
import PluginConfigModal from './PluginConfigModal';
import { usePluginUpdates } from '@/hooks/usePluginUpdates';

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
    // 立即落盘（与 PluginWebviewSlot 的“禁用此插件”一致），避免“有未保存的更改”横幅
    const prevMap = authorizedMap;
    update({ authorizedCapabilities: newMap });
    void useSettingsStore.getState().update({ authorizedCapabilities: newMap }).catch((e) => {
      console.error('保存权限失败:', e);
      update({ authorizedCapabilities: prevMap as Record<string, string[]> });
    });
  };

  return (
    <div className="space-y-2">
      {declared.map((cap) => (
        <div key={cap} className="flex items-center justify-between py-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm text-zinc-300">
              {capabilityLabel(cap)}
            </span>
            {capabilityLabel(cap) !== cap && (
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

function PluginCard({ manifest, appVersion, injectionStatus, updateInfo, onRestartHint }: { manifest: PluginManifest; appVersion: string; injectionStatus?: InjectionStatus; updateInfo?: { marketVersion: string; repoUrl: string }; onRestartHint?: (kind: 'enable' | 'disable', name: string) => void }) {
  const { settings, update } = useSettingsActions();
  const disabledSet = new Set(settings.disabledPlugins ?? []);
  const isDisabled = disabledSet.has(manifest.id);
  const [showCapabilities, setShowCapabilities] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [showRestartHint, setShowRestartHint] = useState(false);
  const [restartHintKind, setRestartHintKind] = useState<'enable' | 'disable'>('disable');
  const [showUninstall, setShowUninstall] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [uninstallDone, setUninstallDone] = useState(false);
  const [uninstallError, setUninstallError] = useState<string | null>(null);
  const [showUpdateConfirm, setShowUpdateConfirm] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateDone, setUpdateDone] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [overlayStatus, setOverlayStatus] = useState<InstallOverlayStatus>({ kind: 'running' });
  const [overlayProgress, setOverlayProgress] = useState<InstallOverlayProgress | null>(null);
  const [installId, setInstallId] = useState<string | null>(null);

  const hasUpdate = !!updateInfo && !updateDone && !uninstallDone;
  const sourceUrl = useMarketStore((s) => s.sourceUrl);

  const handleUpdate = useCallback(async () => {
    if (!updateInfo) return;
    setShowUpdateConfirm(false);
    setUpdateError(null);
    const id = crypto.randomUUID();
    setInstallId(id);
    setOverlayStatus({ kind: 'running' });
    setOverlayProgress(null);
    setOverlayOpen(true);
    setUpdating(true);

    const [unlistenProgress, unlistenDone, unlistenCancelled] = await Promise.all([
      listen<{ installId: string; phase: string; received: number; total: number }>(
        'plugin-install-progress',
        (e) => {
          if (e.payload.installId !== id) return;
          setOverlayProgress({ received: e.payload.received, total: e.payload.total });
        },
      ),
      listen<{ installId: string }>('plugin-install-done', (e) => {
        if (e.payload.installId !== id) return;
        setOverlayStatus({ kind: 'done' });
        setUpdateDone(true);
        setUpdating(false);
        // 回填新版本号（不触发全量 fetch，避免其它插件闪烁）
        if (updateInfo) usePluginStore.getState().patchManifest(manifest.id, { version: updateInfo.marketVersion } as Partial<PluginManifest>);
      }),
      listen<{ installId: string }>('plugin-install-cancelled', (e) => {
        if (e.payload.installId !== id) return;
        setOverlayStatus({ kind: 'cancelled' });
        setUpdating(false);
      }),
    ]);

    try {
      await pluginUpdate(updateInfo.repoUrl, id, sourceUrl || undefined);
      setOverlayStatus({ kind: 'done' });
      setUpdateDone(true);
      setUpdating(false);
      usePluginStore.getState().patchManifest(manifest.id, { version: updateInfo.marketVersion } as Partial<PluginManifest>);
    } catch (e) {
      const parsed = parseAppError(e);
      if (parsed.kind === 'Cancelled' || parsed.message.includes('取消')) {
        setOverlayStatus({ kind: 'cancelled' });
      } else {
        const msg = getErrorMessage(e);
        setOverlayStatus({ kind: 'error', message: msg });
        setUpdateError(msg);
      }
      setUpdating(false);
    } finally {
      unlistenProgress();
      unlistenDone();
      unlistenCancelled();
    }
  }, [updateInfo, sourceUrl]);

  const handleCancelUpdate = useCallback(async () => {
    if (!installId) return;
    setOverlayStatus({ kind: 'cancelling' });
    try {
      await pluginInstallCancel(installId);
    } catch {
      setOverlayStatus({ kind: 'cancelled' });
      setUpdating(false);
    }
  }, [installId]);

  const handleOverlayClose = useCallback(() => {
    setOverlayOpen(false);
    if (overlayStatus.kind === 'done') {
      setUpdateDone(true);
    }
  }, [overlayStatus.kind]);

  const handleUninstall = async () => {
    setUninstalling(true);
    setUninstallError(null);
    try {
      await pluginUninstall(manifest.id);
      setShowUninstall(false);
      // 不主动刷新插件列表（刷新会导致其他插件运行时崩溃），
      // 本地标记展示，重启应用后列表自然对齐。
      setUninstallDone(true);
      // 同步市场页的已安装状态（会话级），重启前市场页不再误显示已安装。
      useMarketStore.getState().markUninstalled(manifest.id);
    } catch (e) {
      setUninstallError(getErrorMessage(e));
    } finally {
      setUninstalling(false);
    }
  };

  // Version compatibility is decided by the backend (Incompatible state);
  // this UI mirror just explains it. Guard on appVersion being loaded to
  // avoid a flicker while getVersion() is still resolving.
  const minRequired = manifest.minAppVersion;
  const incompatible =
    !!minRequired && appVersion.length > 0 && !satisfiesMinVersion(appVersion, minRequired);

  const togglePlugin = () => {
    const current = settings.disabledPlugins ?? [];
    const enabling = isDisabled;
    const next = enabling
      ? current.filter((id) => id !== manifest.id)
      : [...current, manifest.id];
    // 乐观更新 draft 保 UI 即时
    update({ disabledPlugins: next });
    // 立即落盘（与 PluginWebviewSlot 的“禁用此插件”一致），避免“有未保存的更改”
    void useSettingsStore.getState().update({ disabledPlugins: next }).catch((e) => {
      console.error('保存插件开关失败:', e);
      update({ disabledPlugins: current });
    });

    // 启用/禁用均提示重启：禁用后独立窗口不会自动关闭，启用后新视图/注入需重启才完全生效
    const kind = enabling ? 'enable' as const : 'disable' as const;
    if (onRestartHint) {
      onRestartHint(kind, manifest.name);
    } else {
      setRestartHintKind(kind);
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
                {hasUpdate ? (
                  <span className="text-[11px] bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 px-1.5 py-0.5 rounded flex items-center gap-1 flex-shrink-0">
                    v{manifest.version} <span className="text-emerald-500">→</span> v{updateInfo.marketVersion}
                  </span>
                ) : (
                  <span className="text-[11px] text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded flex-shrink-0">v{manifest.version}</span>
                )}
              </div>
              {manifest.publisher && (
                <div className="text-xs text-zinc-500 mt-0.5">{manifest.publisher}</div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {hasUpdate && (
              <Button
                variant="primary"
                size="sm"
                loading={updating}
                disabled={incompatible || uninstallDone || updating}
                onClick={() => setShowUpdateConfirm(true)}
                title={`更新至 v${updateInfo.marketVersion}（保留个人数据）`}
              >
                <ArrowUpCircle className="w-3.5 h-3.5" />
                更新
              </Button>
            )}
            <Button
              variant="danger"
              size="sm"
              disabled={uninstallDone || updating}
              onClick={() => setShowUninstall(true)}
              title="卸载插件（删除目录及其数据）"
            >
              <Trash2 className="w-3.5 h-3.5" />
              卸载
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={!hasConfigView || uninstallDone}
              onClick={() => hasConfigView && setConfigOpen(true)}
              title={hasConfigView ? '打开配置界面' : '此插件未提供配置界面'}
            >
              <Settings className="w-3.5 h-3.5" />
              配置
            </Button>
            {minRequired && (
              <span className={`text-[11px] px-1.5 py-0.5 rounded flex-shrink-0 ${incompatible ? 'text-amber-400 bg-amber-500/10' : 'text-zinc-500 bg-zinc-800'}`}>
                最低兼容 v{minRequired}
              </span>
            )}
            <Toggle
              checked={!isDisabled && !incompatible}
              onChange={togglePlugin}
              disabled={incompatible || uninstallDone || updating}
            />
          </div>
        </div>

      {/* 卸载完成提示 */}
      {uninstallDone && (
        <div className="px-5 py-3 border-b border-zinc-800 bg-emerald-500/5">
          <p className="text-xs text-emerald-400 leading-relaxed">
            已卸载，重启应用后完全移除
          </p>
        </div>
      )}

      {/* 更新完成提示 */}
      {updateDone && (
        <div className="px-5 py-3 border-b border-zinc-800 bg-emerald-500/5">
          <p className="text-xs text-emerald-400 leading-relaxed">
            已更新至 v{updateInfo?.marketVersion}，重启应用后生效
          </p>
        </div>
      )}
      {updateError && !updateDone && (
        <div className="px-5 py-3 border-b border-zinc-800 bg-red-500/5">
          <p className="text-xs text-red-400 leading-relaxed break-all">{updateError}</p>
        </div>
      )}

      {/* Description */}
      {manifest.description && (
        <div className="px-5 py-3 border-b border-zinc-800">
          <p className="text-sm text-zinc-400 leading-relaxed">{manifest.description}</p>
        </div>
      )}

      {/* Incompatibility explanation */}
      {incompatible && minRequired && (
        <div className="px-5 py-3 border-b border-zinc-800 bg-amber-500/5">
          <p className="text-xs text-amber-400 leading-relaxed">
            此插件需要应用 v{minRequired} 及以上版本，当前版本无法启用。
            升级应用后刷新将自动恢复可用。
          </p>
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
        <p>
          {restartHintKind === 'enable'
            ? '某些插件启用后视图或功能不会立即生效，重启应用可以解决。'
            : '某些插件禁用后窗口不会完全关闭，重启应用可以解决。'}
        </p>
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

    <Modal
      open={showUninstall}
      onClose={() => setShowUninstall(false)}
      title="卸载插件"
      size="sm"
    >
      <div className="px-4 py-3 text-sm text-zinc-300 leading-relaxed">
        <p>
          确定卸载「{manifest.name}」？将删除插件目录及其全部数据
          （如记忆文件），重启应用后完全移除。
        </p>
        {uninstallError && (
          <p className="mt-2 text-xs text-red-400">{uninstallError}</p>
        )}
      </div>
      <div className="flex justify-end gap-2 px-4 py-3 border-t border-zinc-700">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setShowUninstall(false)}
        >
          取消
        </Button>
        <Button
          variant="danger"
          size="sm"
          loading={uninstalling}
          onClick={handleUninstall}
        >
          卸载
        </Button>
      </div>
    </Modal>

    <Modal
      open={showUpdateConfirm}
      onClose={() => setShowUpdateConfirm(false)}
      title="更新插件"
      size="sm"
    >
      <div className="px-4 py-3 text-sm text-zinc-300 leading-relaxed">
        <p>
          确定将「{manifest.name}」从 v{manifest.version} 更新至 v{updateInfo?.marketVersion}？
        </p>
        <p className="mt-2 text-xs text-zinc-400">
          将用新版本覆盖插件文件，个人数据（如记忆、配置）会保留，旧版多余文件会被清理。重启后生效。
        </p>
      </div>
      <div className="flex justify-end gap-2 px-4 py-3 border-t border-zinc-700">
        <Button variant="secondary" size="sm" onClick={() => setShowUpdateConfirm(false)}>
          取消
        </Button>
        <Button variant="primary" size="sm" onClick={handleUpdate}>
          更新
        </Button>
      </div>
    </Modal>

    <InstallOverlay
      open={overlayOpen}
      kind="update"
      pluginName={manifest.name}
      status={overlayStatus}
      progress={overlayProgress}
      onCancel={handleCancelUpdate}
      onClose={handleOverlayClose}
    />
    </>
  );
}

export function PluginSection() {
  const manifests = usePluginStore((s) => s.manifests);
  const loading = usePluginStore((s) => s.loading);
  const error = usePluginStore((s) => s.error);
  const fetchPlugins = usePluginStore((s) => s.fetchPlugins);
  const marketPlugins = useMarketStore((s) => s.plugins);
  const marketLoading = useMarketStore((s) => s.loading);
  const marketError = useMarketStore((s) => s.error);
  const fetchMarket = useMarketStore((s) => s.fetch);
  const [pluginDir, setPluginDir] = useState('');
  const [copied, setCopied] = useState(false);
  const [globalRestartHint, setGlobalRestartHint] = useState<{ kind: 'enable' | 'disable'; name: string } | null>(null);
  const appVersion = useAppVersion();

  const injectionStatuses = useInjectionStatuses();
  const statusByPlugin = new Map(injectionStatuses.map((s) => [s.pluginId, s]));

  useEffect(() => {
    getPluginDir().then(setPluginDir);
  }, []);

  // 后台自动检查更新（不阻塞启动，失败静默；仅在首次进入且未检查失败时自动拉一次）
  useEffect(() => {
    if (marketPlugins.length === 0 && !marketLoading && !marketError) {
      void fetchMarket();
    }
  }, [marketPlugins.length, marketLoading, marketError, fetchMarket]);

  const handleCopy = async () => {
    await writeText(pluginDir);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const updateMap = usePluginUpdates(manifests, marketPlugins);
  const updateCount = updateMap.size;

  return (
    <div className="space-y-6">
      {/* Plugin directory + refresh + safe mode */}
      <Card id="settings-plugins" title="插件" description="管理本地安装的插件与主界面注入">
        <SettingItem
          id="plugins-directory"
          label="插件目录"
          description="将插件放入此目录后重启软件即可发现"
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
      </Card>

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-5 py-4 text-sm text-red-400">
          加载失败：{error}
        </div>
      )}

      {/* Update summary + manual check */}
      {!loading && !error && manifests.length > 0 && (
        <div className="flex items-center justify-between px-1">
          <div className="text-xs text-zinc-500">
            {marketLoading ? (
              <span className="inline-flex items-center gap-1.5">
                <RotateCw className="w-3 h-3 animate-spin" />
                正在检查更新…
              </span>
            ) : updateCount > 0 ? (
              <span className="text-emerald-400">发现 {updateCount} 个可更新插件</span>
            ) : marketError ? (
              <span className="text-amber-400">检查更新失败</span>
            ) : (
              <span>已是最新</span>
            )}
          </div>
          <Button
            variant="secondary"
            size="sm"
            loading={marketLoading}
            onClick={() => void fetchMarket()}
            title="检查插件更新"
          >
            <RotateCw className="w-3.5 h-3.5" />
            检查更新
          </Button>
        </div>
      )}

      {/* Plugin cards */}
      {!loading && !error && manifests.length === 0 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-6 py-12 text-center">
          <Puzzle className="w-8 h-8 text-zinc-700 mx-auto mb-3" />
          <p className="text-sm text-zinc-500">暂无已安装插件</p>
          <p className="text-xs text-zinc-600 mt-1">将插件放入上方目录后重启应用</p>
        </div>
      )}

      {!loading && !error && manifests.map((m) => {
        const info = updateMap.get(m.id);
        return (
          <PluginCard
            key={m.id}
            manifest={m}
            appVersion={appVersion}
            injectionStatus={statusByPlugin.get(m.id)}
            updateInfo={info ? { marketVersion: info.marketVersion, repoUrl: info.marketPlugin.repoUrl } : undefined}
            onRestartHint={(kind, name) => setGlobalRestartHint({ kind, name })}
          />
        );
      })}

      <Modal
        open={!!globalRestartHint}
        onClose={() => setGlobalRestartHint(null)}
        title="重启提示"
        size="sm"
      >
        <div className="px-4 py-3 text-sm text-zinc-300">
          <p>
            {globalRestartHint?.kind === 'enable'
              ? `插件「${globalRestartHint?.name}」已启用，某些视图或功能不会立即生效，重启应用可以解决。`
              : `插件「${globalRestartHint?.name}」已禁用，某些窗口不会完全关闭，重启应用可以解决。`}
          </p>
        </div>
        <div className="flex justify-end px-4 py-3 border-t border-zinc-700">
          <Button variant="primary" size="sm" onClick={() => setGlobalRestartHint(null)}>
            知道了
          </Button>
        </div>
      </Modal>

    </div>
  );
}
