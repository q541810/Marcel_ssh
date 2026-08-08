import { useEffect, useState } from 'react';
import {
  Download,
  FolderOpen,
  Shield,
  Wrench,
  Eye,
  Syringe,
  AlertTriangle,
  Check,
  ExternalLink,
  ChevronRight,
  ChevronLeft,
  Trash2,
  RotateCw,
} from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import { marketDetail, pluginInstall, pluginInstallCancel, pluginUninstall } from '@/lib/tauri';
import type { PluginInstallProgress } from '@/lib/types';
import { openExternalLink } from '@/lib/externalLinks';
import { satisfiesMinVersion } from '@/lib/semver';
import { capabilityLabel, capabilityRisk } from '@/lib/pluginCapabilities';
import { useSettingsNavStore } from '@/stores/settingsNavStore';
import { useMarketStore } from '@/stores/marketStore';
import { useSettingsLayout } from '@/components/settings/helpers';
import { STAR_PROMPT_INSTALL_EVENT } from '@/components/star/StarPromptModal';
import { getErrorMessage } from '@/lib/errors';
import type { MarketPlugin, PluginManifest } from '@/lib/types';
import InstallOverlay, {
  type InstallOverlayKind,
  type InstallOverlayProgress,
  type InstallOverlayStatus,
} from './InstallOverlay';

/** 相对路径 → 镜像 URL。跟随后端镜像语义：配置了 GitHub 加速镜像前缀时走
 *  前缀代理（ghfast.top/https://...）；jsDelivr 域名走 jsDelivr 文件镜像；
 *  旧版 index.json 配置 / 未配置时回退 jsDelivr main 分支（国内可达）。 */
function mirrorUrlTransformer(repoUrl: string, mirror: string): (url: string) => string {
  const m = repoUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/);
  if (!m) return (url: string) => url;
  const [owner, repo] = [m[1], m[2]];
  const trimmed = mirror.trim().replace(/\/+$/, '');
  const rel = (url: string) => url.replace(/^\.\//, '');

  if (!trimmed || trimmed.endsWith('index.json')) {
    return (url: string) =>
      /^https?:\/\//.test(url) || url.startsWith('#') || url.startsWith('data:')
        ? url
        : `https://cdn.jsdelivr.net/gh/${owner}/${repo}@main/${rel(url)}`;
  }
  if (trimmed.includes('cdn.jsdelivr.net')) {
    return (url: string) =>
      /^https?:\/\//.test(url) || url.startsWith('#') || url.startsWith('data:')
        ? url
        : `${trimmed}/gh/${owner}/${repo}@main/${rel(url)}`;
  }
  return (url: string) =>
    /^https?:\/\//.test(url) || url.startsWith('#') || url.startsWith('data:')
      ? url
      : `${trimmed}/https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${rel(url)}`;
}

/** 按风险等级分组权限。 */
function groupByRisk(caps: string[]) {
  const high: string[] = [];
  const medium: string[] = [];
  const low: string[] = [];
  for (const cap of caps) {
    const r = capabilityRisk(cap);
    if (r === 'high') high.push(cap);
    else if (r === 'medium') medium.push(cap);
    else low.push(cap);
  }
  return { high, medium, low };
}

/** 详情图标，复用列表的回退逻辑但尺寸更大。 */
function DetailIcon({ plugin }: { plugin: MarketPlugin }) {
  const [fallback, setFallback] = useState(false);
  useEffect(() => setFallback(false), [plugin.id, plugin.icon?.value]);

  if (fallback || !plugin.icon) {
    return (
      <span className="w-20 h-20 rounded-2xl bg-zinc-800/80 flex items-center justify-center text-zinc-500 flex-shrink-0 border border-zinc-700/50">
        <Shield className="w-9 h-9" />
      </span>
    );
  }
  if (plugin.icon.kind === 'img') {
    return (
      <img
        src={plugin.icon.value}
        alt=""
        className="w-20 h-20 rounded-2xl object-cover flex-shrink-0 bg-zinc-800 border border-zinc-700/50"
        onError={() => setFallback(true)}
      />
    );
  }
  return (
    <span className="w-20 h-20 rounded-2xl bg-zinc-800/80 flex items-center justify-center flex-shrink-0 border border-zinc-700/50 text-4xl">
      {plugin.icon.value}
    </span>
  );
}

/** Manifest 摘要：视图/工具/注入计数。 */
function ManifestSummary({ manifest }: { manifest: PluginManifest }) {
  const viewCount = manifest.views?.length ?? 0;
  const toolCount = manifest.agentTools?.length ?? 0;
  const injectionCount = manifest.injections?.length ?? 0;
  return (
    <div className="flex items-center gap-4 text-xs text-zinc-500">
      {viewCount > 0 && (
        <span className="inline-flex items-center gap-1.5">
          <Eye className="w-3.5 h-3.5" /> {viewCount} 视图
        </span>
      )}
      {toolCount > 0 && (
        <span className="inline-flex items-center gap-1.5">
          <Wrench className="w-3.5 h-3.5" /> {toolCount} 工具
        </span>
      )}
      {injectionCount > 0 && (
        <span className="inline-flex items-center gap-1.5">
          <Syringe className="w-3.5 h-3.5" /> {injectionCount} 注入
        </span>
      )}
    </div>
  );
}

/** 单个权限 chip。 */
function CapabilityChip({ cap }: { cap: string }) {
  const risk = capabilityRisk(cap);
  const tone =
    risk === 'high'
      ? 'text-amber-300 bg-amber-500/10 border-amber-500/20'
      : risk === 'medium'
        ? 'text-zinc-300 bg-zinc-800 border-zinc-700'
        : 'text-zinc-500 bg-zinc-800/50 border-zinc-800';
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border ${tone}`}
      title={risk === 'high' ? '高风险权限' : risk === 'medium' ? '中风险' : '低风险'}
    >
      {capabilityLabel(cap)}
    </span>
  );
}

/** 一键安装 / 卸载：全屏覆盖层驱动（运行中不可关闭、可取消），完成后把
 *  安装状态写入 marketStore（会话级），重启前跨页面进出保持一致。 */
function useInstallActions(plugin: MarketPlugin) {
  const mirror = useMarketStore((s) => s.sourceUrl);
  const markInstalled = useMarketStore((s) => s.markInstalled);
  const markUninstalled = useMarketStore((s) => s.markUninstalled);

  const [overlayOpen, setOverlayOpen] = useState(false);
  const [overlayKind, setOverlayKind] = useState<InstallOverlayKind>('install');
  const [status, setStatus] = useState<InstallOverlayStatus>({ kind: 'running' });
  const [progress, setProgress] = useState<InstallOverlayProgress | null>(null);
  const [installId, setInstallId] = useState<string | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState(false);

  // 订阅本次安装任务的进度/完成/取消事件。installId 非空时挂载监听，
  // 关闭覆盖层时解除。
  useEffect(() => {
    if (!installId) return;
    let disposed = false;
    let unlistenFns: Array<() => void> = [];
    Promise.all([
      listen<PluginInstallProgress>('plugin-install-progress', (e) => {
        if (e.payload.installId !== installId) return;
        setProgress({ received: e.payload.received, total: e.payload.total });
      }),
      listen<{ installId: string }>('plugin-install-done', (e) => {
        if (e.payload.installId !== installId) return;
        markInstalled(plugin.id);
        setStatus({ kind: 'done' });
      }),
      listen<{ installId: string }>('plugin-install-cancelled', (e) => {
        if (e.payload.installId !== installId) return;
        setStatus({ kind: 'cancelled' });
      }),
    ]).then((fns) => {
      if (disposed) {
        fns.forEach((fn) => fn());
      } else {
        unlistenFns = fns;
      }
    });
    return () => {
      disposed = true;
      unlistenFns.forEach((fn) => fn());
    };
  }, [installId, plugin.id, markInstalled]);

  const install = async () => {
    const id = crypto.randomUUID();
    setOverlayKind('install');
    setStatus({ kind: 'running' });
    setProgress(null);
    setInstallId(id);
    setOverlayOpen(true);
    try {
      await pluginInstall(plugin.repoUrl, id, mirror || undefined);
      markInstalled(plugin.id);
      setStatus({ kind: 'done' });
      // 安装成功是求 Star 的最佳时机（正反馈时刻），由 StarPromptModal 按限频判定。
      window.dispatchEvent(new Event(STAR_PROMPT_INSTALL_EVENT));
    } catch (e) {
      // 取消路径由 cancelled 事件置态；这里只兜底非取消错误
      setStatus((cur) =>
        cur.kind === 'cancelling' || cur.kind === 'cancelled'
          ? cur
          : { kind: 'error', message: getErrorMessage(e) },
      );
    } finally {
      setInstallId(null);
    }
  };

  const cancelInstall = async () => {
    if (!installId) return;
    setStatus({ kind: 'cancelling' });
    try {
      await pluginInstallCancel(installId);
    } catch (e) {
      console.error('cancel install failed:', e);
    }
  };

  const uninstall = async () => {
    setOverlayKind('uninstall');
    setStatus({ kind: 'running' });
    setProgress(null);
    setOverlayOpen(true);
    try {
      await pluginUninstall(plugin.id);
      markUninstalled(plugin.id);
      setStatus({ kind: 'done' });
    } catch (e) {
      setStatus({ kind: 'error', message: getErrorMessage(e) });
    }
  };

  const closeOverlay = () => {
    setOverlayOpen(false);
    setStatus({ kind: 'running' });
    setProgress(null);
  };

  return {
    mirror,
    status,
    progress,
    overlayOpen,
    overlayKind,
    confirmUninstall,
    setConfirmUninstall,
    install,
    cancelInstall,
    uninstall,
    closeOverlay,
  };
}

export function MarketDetailPanel({
  plugin,
  appVersion,
  installed,
  onBack,
}: {
  plugin: MarketPlugin;
  appVersion: string;
  installed: boolean;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<{ manifest: PluginManifest | null; readme: string | null }>({
    manifest: null,
    readme: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const layout = useSettingsLayout();
  const padX = `${layout.contentPaddingX}px`;
  const installActions = useInstallActions(plugin);
  const { mirror } = installActions;
  const uiInstalled = installed;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetail({ manifest: null, readme: null });
    marketDetail(plugin.repoUrl, mirror || undefined)
      .then((d) => {
        if (!cancelled) setDetail({ manifest: d.manifest, readme: d.readme });
      })
      .catch((e) => {
        if (!cancelled) setError(getErrorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [plugin.repoUrl, mirror, retryKey]);

  const minRequired = plugin.minAppVersion ?? null;
  const incompatible =
    !!minRequired && appVersion.length > 0 && !satisfiesMinVersion(appVersion, minRequired);
  const urlTransform = mirrorUrlTransformer(plugin.repoUrl, mirror);
  const { high, medium, low } = groupByRisk(plugin.capabilities);

  const goToPluginSettings = () => {
    useSettingsNavStore.getState().requestNavigate('plugins');
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ─── Header（吸顶，半透明材质，含返回按钮） ─── */}
      <div
        className="flex-shrink-0 border-b border-zinc-800 bg-zinc-900/80 backdrop-blur-xl py-3"
        style={{ paddingLeft: padX, paddingRight: padX }}
      >
        {/* 返回按钮行 */}
        <div className="flex items-center gap-2 mb-3">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200 transition-colors px-2 py-1 -ml-2 rounded-lg hover:bg-zinc-800/60"
          >
            <ChevronLeft className="w-4 h-4" />
            返回插件市场
          </button>
        </div>
        {/* 标题行 */}
        <div className="flex items-start gap-4 min-w-0">
          <DetailIcon plugin={plugin} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1
                className="text-lg font-semibold text-zinc-100"
                style={{ letterSpacing: '-0.01em' }}
              >
                {plugin.name}
              </h1>
              <span className="text-[11px] text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded font-mono tracking-wide">
                v{plugin.version}
              </span>
              {uiInstalled && (
                <span className="inline-flex items-center gap-0.5 text-[11px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded">
                  <Check className="w-3 h-3" />
                  已安装
                </span>
              )}
              {incompatible && minRequired && (
                <span className="text-[11px] text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">
                  需要应用 v{minRequired}
                </span>
              )}
            </div>
            <div className="text-xs text-zinc-500 mt-1 flex items-center gap-2 flex-wrap">
              {plugin.publisher && <span>{plugin.publisher}</span>}
              {plugin.category && (
                <>
                  <span className="text-zinc-700">·</span>
                  <span>#{plugin.category}</span>
                </>
              )}
              {minRequired && !incompatible && (
                <>
                  <span className="text-zinc-700">·</span>
                  <span className="text-zinc-600">最低兼容 v{minRequired}</span>
                </>
              )}
            </div>
            {detail.manifest && (
              <div className="mt-2">
                <ManifestSummary manifest={detail.manifest} />
              </div>
            )}
          </div>
          {/* 主 CTA：根据状态变化 */}
          <div className="flex flex-col items-end gap-2 flex-shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => openExternalLink(plugin.repoUrl)}
              title="打开 GitHub 项目主页"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              项目主页
            </Button>
            {uiInstalled ? (
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={goToPluginSettings}>
                  <FolderOpen className="w-3.5 h-3.5" />
                  管理插件
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => installActions.setConfirmUninstall(true)}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  卸载
                </Button>
              </div>
            ) : incompatible ? (
              <Button variant="secondary" size="sm" disabled title="当前应用版本不兼容">
                <AlertTriangle className="w-3.5 h-3.5" />
                不兼容
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                disabled={installActions.overlayOpen}
                onClick={installActions.install}
              >
                <Download className="w-3.5 h-3.5" />
                一键安装
              </Button>
            )}
          </div>
        </div>

        {/* 不兼容说明条 */}
        {incompatible && minRequired && (
          <div className="mt-3 rounded-lg bg-amber-500/5 border border-amber-500/20 px-3 py-2">
            <p className="text-xs text-amber-400 leading-relaxed">
              此插件需要应用 v{minRequired} 及以上版本。升级应用后刷新插件市场将自动恢复可用。
            </p>
          </div>
        )}
      </div>

      {/* ─── Body（滚动） ─── */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="py-5 space-y-5" style={{ paddingLeft: padX, paddingRight: padX }}>
          {/* 描述 */}
          {plugin.description && (
            <p className="text-sm text-zinc-400 leading-relaxed">{plugin.description}</p>
          )}

          {/* 已安装提示 */}
          {uiInstalled && (
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 flex items-center gap-3">
              <Check className="w-4 h-4 text-emerald-400 flex-shrink-0" />
              <div className="flex-1">
                <p className="text-sm text-emerald-300">此插件已安装</p>
                <p className="text-xs text-emerald-400/70 mt-0.5">
                  在插件设置中管理权限、配置和启用状态
                </p>
              </div>
              <Button variant="secondary" size="sm" onClick={goToPluginSettings}>
                管理
                <ChevronRight className="w-3.5 h-3.5" />
              </Button>
            </div>
          )}

          {/* 权限声明：全部默认收起，summary 显示高风险数提示 */}
          {plugin.capabilities.length > 0 && (
            <details className="group rounded-lg border border-zinc-800 bg-zinc-900/40 overflow-hidden">
              <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer list-none select-none hover:bg-zinc-800/40 transition-colors">
                <Shield className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" />
                <span className="text-sm font-medium text-zinc-300 flex-1">
                  权限声明
                </span>
                <span
                  className={`text-xs ${
                    high.length > 0
                      ? 'text-amber-400'
                      : 'text-zinc-600'
                  }`}
                >
                  {plugin.capabilities.length} 项
                  {high.length > 0 && ` · ${high.length} 高风险`}
                </span>
                <ChevronRight className="w-3.5 h-3.5 text-zinc-500 transition-transform group-open:rotate-90" />
              </summary>
              <div className="px-3 py-2 space-y-2 border-t border-zinc-800">
                {high.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-[11px] text-amber-400/80 font-medium">高风险</p>
                    <div className="flex flex-wrap gap-1.5">
                      {high.map((cap) => (
                        <CapabilityChip key={cap} cap={cap} />
                      ))}
                    </div>
                  </div>
                )}
                {medium.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-[11px] text-zinc-500 font-medium">中风险</p>
                    <div className="flex flex-wrap gap-1.5">
                      {medium.map((cap) => (
                        <CapabilityChip key={cap} cap={cap} />
                      ))}
                    </div>
                  </div>
                )}
                {low.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-[11px] text-zinc-600 font-medium">低风险</p>
                    <div className="flex flex-wrap gap-1.5">
                      {low.map((cap) => (
                        <CapabilityChip key={cap} cap={cap} />
                      ))}
                    </div>
                  </div>
                )}
                <p className="text-[11px] text-zinc-600 leading-relaxed pt-1">
                  安装前请审查插件源代码，上架不代表官方背书。
                </p>
              </div>
            </details>
          )}

          {/* README */}
          <div>
            {loading ? (
              <div className="space-y-3">
                <div className="h-4 bg-zinc-800 rounded animate-pulse w-1/3" />
                <div className="h-3 bg-zinc-800/70 rounded animate-pulse w-full" />
                <div className="h-3 bg-zinc-800/70 rounded animate-pulse w-5/6" />
                <div className="h-3 bg-zinc-800/70 rounded animate-pulse w-4/6" />
                <div className="h-4 bg-zinc-800 rounded animate-pulse w-1/4 mt-4" />
                <div className="h-3 bg-zinc-800/70 rounded animate-pulse w-full" />
                <div className="h-3 bg-zinc-800/70 rounded animate-pulse w-3/4" />
              </div>
            ) : error ? (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 py-8 text-center">
                <AlertTriangle className="w-6 h-6 text-zinc-600 mx-auto mb-2" />
                <p className="text-sm text-zinc-500 mb-1">详情加载失败</p>
                <p className="text-xs text-zinc-600 mb-3 px-6">{error}</p>
                <div className="flex items-center justify-center gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setRetryKey((k) => k + 1)}>
                    <RotateCw className="w-3.5 h-3.5" />
                    重试
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => openExternalLink(plugin.repoUrl)}
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    前往仓库查看
                  </Button>
                </div>
              </div>
            ) : detail.readme ? (
              <div className="text-sm leading-relaxed text-zinc-100 break-words prose prose-invert prose-sm max-w-none prose-p:my-2 prose-code:text-pink-300 prose-code:bg-zinc-800 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none prose-pre:bg-zinc-950 prose-pre:border prose-pre:border-zinc-700 prose-a:text-indigo-400 prose-headings:my-3 prose-headings:text-zinc-100 prose-headings:font-semibold prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-blockquote:border-l-zinc-600 prose-blockquote:text-zinc-400 prose-blockquote:italic prose-img:rounded-lg prose-img:max-h-80 prose-img:object-contain prose-table:text-xs prose-th:border prose-th:border-zinc-700 prose-th:px-2 prose-th:py-1 prose-td:border prose-td:border-zinc-800 prose-td:px-2 prose-td:py-1">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  urlTransform={urlTransform}
                  components={{
                    a: ({ href, children, ...props }) => (
                      <a
                        {...props}
                        href={href}
                        onClick={(event) => {
                          event.preventDefault();
                          if (href) openExternalLink(href);
                        }}
                      >
                        {children}
                      </a>
                    ),
                    img: ({ src, alt, ...props }) => (
                      <img
                        {...props}
                        src={src}
                        alt={alt ?? ''}
                        loading="lazy"
                        className="rounded-lg"
                        onError={(e) => {
                          const img = e.currentTarget;
                          // jsDelivr 形态（@main）404 时回退 @master（与后端
                          // raw_file_urls 的 main/master 兜底保持一致）。
                          if (img.src.includes('@main/')) {
                            img.src = img.src.replace('@main/', '@master/');
                          } else {
                            img.style.opacity = '0.3';
                          }
                        }}
                      />
                    ),
                  }}
                >
                  {detail.readme}
                </ReactMarkdown>
              </div>
            ) : (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 py-8 text-center">
                <p className="text-sm text-zinc-500">此仓库没有 README</p>
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-3"
                  onClick={() => openExternalLink(plugin.repoUrl)}
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  前往仓库
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 卸载确认 */}
      <Modal
        open={installActions.confirmUninstall}
        onClose={() => installActions.setConfirmUninstall(false)}
        title="卸载插件"
        size="sm"
      >
        <div className="px-4 py-3 text-sm text-zinc-300 leading-relaxed">
          <p>
            确定卸载「{plugin.name}」？将删除插件目录及其全部数据
            （如记忆文件），重启应用后完全移除。
          </p>
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-zinc-700">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => installActions.setConfirmUninstall(false)}
          >
            取消
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => {
              installActions.setConfirmUninstall(false);
              installActions.uninstall();
            }}
          >
            卸载
          </Button>
        </div>
      </Modal>

      {/* 安装/卸载全屏覆盖层：运行中不可关闭，完成后提示重启生效 */}
      <InstallOverlay
        open={installActions.overlayOpen}
        kind={installActions.overlayKind}
        pluginName={plugin.name}
        status={installActions.status}
        progress={installActions.progress}
        onCancel={installActions.cancelInstall}
        onClose={installActions.closeOverlay}
      />
    </div>
  );
}
