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
  RefreshCw,
  ChevronRight,
  ChevronLeft,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Button from '@/components/ui/Button';
import { marketDetail, openPluginDir } from '@/lib/tauri';
import { openExternalLink } from '@/lib/externalLinks';
import { satisfiesMinVersion } from '@/lib/semver';
import { capabilityLabel, capabilityRisk } from '@/lib/pluginCapabilities';
import { useSettingsNavStore } from '@/stores/settingsNavStore';
import { usePluginStore } from '@/stores/pluginStore';
import { useSettingsLayout } from '@/components/settings/helpers';
import { getErrorMessage } from '@/lib/errors';
import type { MarketPlugin, PluginManifest } from '@/lib/types';

/** 从 repoUrl 提取 GitHub 相对路径图片的 raw 前缀。 */
function rawUrlTransformer(repoUrl: string): (url: string) => string {
  const m = repoUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/);
  const base = m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/HEAD/` : null;
  return (url: string) => {
    if (!base || /^https?:\/\//.test(url) || url.startsWith('#') || url.startsWith('data:')) return url;
    return base + url.replace(/^\.\//, '');
  };
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

/** 分步安装引导。仅在未安装且兼容时显示。 */
function InstallGuide({ plugin, onInstalled }: { plugin: MarketPlugin; onInstalled: () => void }) {
  const [step, setStep] = useState(0); // 0=未开始, 1=已下载, 2=已放入目录, 3=已刷新
  const fetchPlugins = usePluginStore((s) => s.fetchPlugins);

  const steps = [
    {
      title: '下载插件',
      desc: '点击下方按钮前往 GitHub 仓库下载插件压缩包',
      action: (
        <Button variant="secondary" size="sm" onClick={() => openExternalLink(plugin.repoUrl)}>
          <ExternalLink className="w-3.5 h-3.5" />
          前往仓库
        </Button>
      ),
      next: () => setStep(1),
      nextLabel: '我已下载',
    },
    {
      title: '放入插件目录',
      desc: (
        <>
          <div>解压压缩包到插件目录，目录结构如下：</div>
          <pre className="mt-1.5 text-[11px] leading-relaxed font-mono text-zinc-400 bg-zinc-950 border border-zinc-800 rounded-md p-2 overflow-x-auto">{`插件目录/
└── 插件文件夹/
    ├── plugin.json   ← 必须在这里
    └── 其他文件/文件夹`}</pre>
        </>
      ),
      action: (
        <Button variant="secondary" size="sm" onClick={() => openPluginDir()}>
          <FolderOpen className="w-3.5 h-3.5" />
          打开目录
        </Button>
      ),
      next: () => setStep(2),
      nextLabel: '我已放入',
    },
    {
      title: '重启应用加载',
      desc: '插件已放入目录，重启应用后插件将自动加载',
      action: (
        <Button
          variant="primary"
          size="sm"
          onClick={async () => {
            await fetchPlugins();
            setStep(3);
            onInstalled();
          }}
        >
          <RefreshCw className="w-3.5 h-3.5" />
          刷新
        </Button>
      ),
      next: null,
      nextLabel: '',
    },
  ];

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-zinc-800 flex items-center gap-2">
        <Download className="w-3.5 h-3.5 text-indigo-400" />
        <span className="text-xs font-medium text-zinc-300">安装步骤</span>
      </div>
      <div className="divide-y divide-zinc-800/60">
        {steps.map((s, i) => {
          const completed = step > i;
          const current = step === i;
          return (
            <div
              key={i}
              className={`px-4 py-3 flex items-start gap-3 transition-colors ${
                current ? 'bg-indigo-500/5' : ''
              }`}
            >
              {/* 序号 / 完成标记 */}
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 text-[11px] font-medium transition-colors ${
                  completed
                    ? 'bg-emerald-500/20 text-emerald-400'
                    : current
                      ? 'bg-indigo-500/20 text-indigo-300'
                      : 'bg-zinc-800 text-zinc-500'
                }`}
              >
                {completed ? <Check className="w-3.5 h-3.5" /> : i + 1}
              </div>
              {/* 内容 */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`text-sm font-medium ${
                      completed ? 'text-zinc-500 line-through' : 'text-zinc-200'
                    }`}
                  >
                    {s.title}
                  </span>
                  {s.action}
                </div>
                <div className="text-xs text-zinc-500 mt-0.5 leading-relaxed">{s.desc}</div>
                {current && s.next && (
                  <button
                    type="button"
                    onClick={s.next}
                    className="mt-2 inline-flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                  >
                    {s.nextLabel}
                    <ChevronRight className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
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
  const layout = useSettingsLayout();
  const padX = `${layout.contentPaddingX}px`;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetail({ manifest: null, readme: null });
    marketDetail(plugin.repoUrl)
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
  }, [plugin.repoUrl]);

  const minRequired = plugin.minAppVersion ?? null;
  const incompatible =
    !!minRequired && appVersion.length > 0 && !satisfiesMinVersion(appVersion, minRequired);
  const urlTransform = rawUrlTransformer(plugin.repoUrl);
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
              {installed && (
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
          <div className="flex-shrink-0">
            {installed ? (
              <Button variant="secondary" size="sm" onClick={goToPluginSettings}>
                <FolderOpen className="w-3.5 h-3.5" />
                管理插件
              </Button>
            ) : incompatible ? (
              <Button variant="secondary" size="sm" disabled title="当前应用版本不兼容">
                <AlertTriangle className="w-3.5 h-3.5" />
                不兼容
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={() => openExternalLink(plugin.repoUrl)}>
                <Download className="w-3.5 h-3.5" />
                前往下载
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

          {/* 安装引导（未安装且兼容时） */}
          {!installed && !incompatible && (
            <InstallGuide plugin={plugin} onInstalled={() => {}} />
          )}

          {/* 已安装提示 */}
          {installed && (
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
                <p className="text-xs text-zinc-600 mb-3">{error}</p>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => openExternalLink(plugin.repoUrl)}
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  前往仓库查看
                </Button>
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
                          e.currentTarget.style.opacity = '0.3';
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
    </div>
  );
}
