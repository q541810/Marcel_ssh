import { useEffect, useMemo, useState } from 'react';
import {
  Globe,
  RefreshCw,
  Search,
  Send,
  Store,
  X,
  AlertCircle,
  Check,
  Shield,
} from 'lucide-react';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import { useMarketStore } from '@/stores/marketStore';
import { usePluginStore } from '@/stores/pluginStore';
import { useAppVersion } from '@/hooks/useAppVersion';
import { satisfiesMinVersion } from '@/lib/semver';
import { capabilityRisk } from '@/lib/pluginCapabilities';
import { useSettingsLayout } from '@/components/settings/helpers';
import { openExternalLink, PLUGIN_SUBMIT_URL } from '@/lib/externalLinks';
import { MarketDetailPanel } from './MarketDetailPanel';
import type { MarketPlugin } from '@/lib/types';

/** 相对时间格式化。 */
function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const days = Math.floor(diff / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

/** 高风险权限数量。 */
function highRiskCount(caps: string[]): number {
  return caps.filter((c) => capabilityRisk(c) === 'high').length;
}

/** 横向卡片图标（56px，左侧视觉锚点）。 */
function CardIcon({ plugin }: { plugin: MarketPlugin }) {
  const [fallback, setFallback] = useState(false);
  useEffect(() => setFallback(false), [plugin.id, plugin.icon?.value]);

  if (fallback || !plugin.icon) {
    return (
      <div className="w-14 h-14 rounded-xl bg-zinc-800/80 flex items-center justify-center text-zinc-500 flex-shrink-0 border border-zinc-700/40">
        <Store className="w-7 h-7" />
      </div>
    );
  }
  if (plugin.icon.kind === 'img') {
    return (
      <img
        src={plugin.icon.value}
        alt=""
        className="w-14 h-14 rounded-xl object-cover bg-zinc-800 flex-shrink-0 border border-zinc-700/40"
        loading="lazy"
        onError={() => setFallback(true)}
      />
    );
  }
  return (
    <div className="w-14 h-14 rounded-xl bg-zinc-800/80 flex items-center justify-center flex-shrink-0 border border-zinc-700/40">
      <span className="text-2xl">{plugin.icon.value}</span>
    </div>
  );
}

/** 骨架屏卡片。 */
function SkeletonCard({ index }: { index: number }) {
  return (
    <div
      className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3 flex items-center gap-3"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <div className="w-14 h-14 rounded-xl bg-zinc-800 animate-pulse flex-shrink-0" />
      <div className="flex-1 space-y-2">
        <div className="h-3.5 bg-zinc-800 rounded animate-pulse w-2/5" />
        <div className="h-2.5 bg-zinc-800/70 rounded animate-pulse w-3/4" />
      </div>
    </div>
  );
}

/** 状态徽标。 */
function StatusBadges({
  installed,
  incompatible,
  minRequired,
  highRisk,
}: {
  installed: boolean;
  incompatible: boolean;
  minRequired: string | null;
  highRisk: number;
}) {
  return (
    <>
      {installed && (
        <span className="inline-flex items-center gap-0.5 text-[10px] text-emerald-400 bg-emerald-500/15 px-1.5 py-0.5 rounded-full border border-emerald-500/20">
          <Check className="w-2.5 h-2.5" />
          已安装
        </span>
      )}
      {incompatible && minRequired && (
        <span className="text-[10px] text-amber-400 bg-amber-500/15 px-1.5 py-0.5 rounded-full border border-amber-500/20">
          需 v{minRequired}
        </span>
      )}
      {highRisk > 0 && !incompatible && (
        <span
          className="inline-flex items-center gap-0.5 text-[10px] text-amber-400/80 bg-amber-500/10 px-1.5 py-0.5 rounded-full border border-amber-500/15"
          title={`${highRisk} 个高风险权限`}
        >
          <Shield className="w-2.5 h-2.5" />
          {highRisk} 高风险
        </span>
      )}
    </>
  );
}

export function MarketSection() {
  const { plugins, loading, error, fetch: fetchMarket, sourceUrl, setSource } = useMarketStore();
  const localManifests = usePluginStore((s) => s.manifests);
  const appVersion = useAppVersion();
  const layout = useSettingsLayout();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [selected, setSelected] = useState<MarketPlugin | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceDraft, setSourceDraft] = useState('');

  // 横向 padding 与设置页其他 section 保持一致
  const padX = `${layout.contentPaddingX}px`;
  // 卡片网格列数跟随设置页 sectionColumns：compact/normal 单列，wide/extraWide 双列
  const gridCols = layout.sectionColumns === 2 ? 'md:grid-cols-2' : 'grid-cols-1';

  useEffect(() => {
    // 每次进入市场页都拉最新索引（GitHub/镜像更新后重新进入即可看到，无需手动刷新）
    fetchMarket();
  }, [fetchMarket]);

  const categories = useMemo(() => {
    const set = new Set(plugins.map((p) => p.category).filter(Boolean));
    return ['all', ...Array.from(set).sort()];
  }, [plugins]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: plugins.length };
    for (const p of plugins) {
      if (p.category) counts[p.category] = (counts[p.category] ?? 0) + 1;
    }
    return counts;
  }, [plugins]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return plugins.filter((p) => {
      if (category !== 'all' && p.category !== category) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.publisher.toLowerCase().includes(q)
      );
    });
  }, [plugins, query, category]);

  const installedIds = useMemo(
    () => new Set(localManifests.map((m) => m.id)),
    [localManifests],
  );

  // 提交插件页跟随镜像语义：配置了 GitHub 加速镜像前缀时走镜像打开，
  // 否则直连 GitHub。jsDelivr 单文件镜像不支持网页浏览，保持直连。
  const submitUrl = useMemo(() => {
    const trimmed = sourceUrl.trim().replace(/\/+$/, '');
    const proxied =
      trimmed &&
      !trimmed.endsWith('index.json') &&
      !trimmed.includes('cdn.jsdelivr.net');
    return proxied ? `${trimmed}/${PLUGIN_SUBMIT_URL}` : PLUGIN_SUBMIT_URL;
  }, [sourceUrl]);

  const saveSource = () => {
    setSource(sourceDraft.trim());
    setSourceOpen(false);
    fetchMarket();
  };

  // 详情页视图
  if (selected) {
    return (
      <MarketDetailPanel
        plugin={selected}
        appVersion={appVersion}
        installed={installedIds.has(selected.id)}
        onBack={() => setSelected(null)}
      />
    );
  }

  // 信息流视图
  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ─── 顶部工具栏（吸顶，半透明材质） ─── */}
      <div className="flex-shrink-0 border-b border-zinc-800 bg-zinc-900/80 backdrop-blur-xl">
        <div className="py-3 space-y-2.5" style={{ paddingLeft: padX, paddingRight: padX }}>
          {/* 标题行 */}
          <div className="flex items-center gap-3">
            <h1
              className="text-lg font-semibold text-zinc-100"
              style={{ letterSpacing: '-0.01em' }}
            >
              插件市场
            </h1>
            <span className="text-xs text-zinc-600">{plugins.length} 个插件</span>
            <div className="flex-1" />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => openExternalLink(submitUrl)}
              title={sourceUrl ? '通过当前镜像打开插件提交仓库' : '打开插件提交仓库'}
            >
              <Send className="w-3.5 h-3.5" />
              我要提交
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setSourceDraft(sourceUrl);
                setSourceOpen((v) => !v);
              }}
              title={sourceUrl ? '当前：自定义镜像' : '当前：内置默认镜像'}
            >
              <Globe className="w-3.5 h-3.5" />
              {sourceUrl ? '自定义' : '默认'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={loading}
              onClick={() => fetchMarket()}
              title="刷新"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>

          {/* 搜索 + 分类 */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[200px] max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500 pointer-events-none" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索插件、作者…"
                className="pl-8 pr-8"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-zinc-500 hover:text-zinc-300 transition-colors"
                  aria-label="清除搜索"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {categories.length > 1 && (
              <div className="flex items-center gap-1.5 overflow-x-auto">
                {categories.map((c) => {
                  const active = category === c;
                  const count = categoryCounts[c] ?? 0;
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setCategory(c)}
                      className={`text-[11px] px-2.5 py-1 rounded-full transition-all duration-200 flex-shrink-0 inline-flex items-center gap-1.5 ${
                        active
                          ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-500/30'
                          : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/60 border border-transparent'
                      }`}
                      style={{ transitionTimingFunction: 'var(--spring-bounce)' }}
                    >
                      {c === 'all' ? '全部' : c}
                      {count > 0 && (
                        <span className={`text-[10px] ${active ? 'text-indigo-400/70' : 'text-zinc-600'}`}>
                          {count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* 源设置折叠区 */}
          {sourceOpen && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-2">
              <p className="text-[11px] text-zinc-500 leading-relaxed">
                填写 GitHub 加速镜像前缀（如 https://ghfast.top），市场列表、详情、图片与插件下载统一走该镜像。留空使用内置默认（jsDelivr 拉取列表 + 内置镜像下载 + GitHub 直连兜底）。
              </p>
              <p className="text-[11px] text-zinc-600 leading-relaxed">
                注意：旧版填写的完整 index.json 地址仍可用，但仅市场列表走该地址，详情与插件下载会直连 GitHub。
              </p>
              <Input
                value={sourceDraft}
                onChange={(e) => setSourceDraft(e.target.value)}
                placeholder="https://ghfast.top（留空 = 内置默认镜像）"
                className="text-xs font-mono"
              />
              <div className="flex justify-between items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSourceDraft('')}
                  className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  恢复默认源
                </button>
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setSourceOpen(false)}>
                    取消
                  </Button>
                  <Button variant="primary" size="sm" onClick={saveSource}>
                    保存并刷新
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ─── 错误条 ─── */}
      {error && (
        <div
          className="flex-shrink-0 py-2.5 border-b border-zinc-800 bg-red-500/5 flex items-center gap-2"
          style={{ paddingLeft: padX, paddingRight: padX }}
        >
          <AlertCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
          <p className="text-xs text-red-400 flex-1 truncate" title={error}>
            {error}
          </p>
          <button
            type="button"
            onClick={() => fetchMarket()}
            className="text-[11px] text-red-400 hover:text-red-300 underline flex-shrink-0"
          >
            重试
          </button>
        </div>
      )}

      {/* ─── 信息流列表（跟随 sectionColumns 自适应列数） ─── */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div
          className={`grid gap-2 py-4 ${gridCols}`}
          style={{ paddingLeft: padX, paddingRight: padX }}
        >
          {/* 骨架屏 */}
          {loading && plugins.length === 0 &&
            [0, 1, 2, 3, 4, 5, 6, 7].map((i) => <SkeletonCard key={i} index={i} />)}

          {/* 空态 */}
          {!loading && !error && filtered.length === 0 && (
            <div className="py-20 text-center col-span-full">
              <Store className="w-12 h-12 text-zinc-700 mx-auto mb-3" />
              <p className="text-sm text-zinc-500">
                {query || category !== 'all' ? '没有匹配的插件' : '插件市场暂无插件'}
              </p>
              {(query || category !== 'all') && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery('');
                    setCategory('all');
                  }}
                  className="mt-2 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                >
                  清除筛选
                </button>
              )}
            </div>
          )}

          {/* 卡片列表 */}
          {filtered.map((p) => {
            const installed = installedIds.has(p.id);
            const minRequired = p.minAppVersion ?? null;
            const incompatible =
              !!minRequired && appVersion.length > 0 && !satisfiesMinVersion(appVersion, minRequired);
            const highRisk = highRiskCount(p.capabilities);

            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelected(p)}
                className="group w-full text-left rounded-xl border border-zinc-800 bg-zinc-900/40 hover:border-zinc-700 hover:bg-zinc-800/40 px-4 py-3 transition-all duration-200 active:scale-[0.99]"
                style={{ transitionTimingFunction: 'var(--spring-bounce)' }}
              >
                <div className="flex items-start gap-3 min-w-0">
                  <CardIcon plugin={p} />
                  <div className="flex-1 min-w-0">
                    {/* 主信息行 */}
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span
                        className="text-sm font-semibold text-zinc-100 truncate"
                        style={{ letterSpacing: '-0.01em' }}
                      >
                        {p.name}
                      </span>
                      <span className="text-[10px] text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded font-mono flex-shrink-0 tracking-wide">
                        v{p.version}
                      </span>
                      <StatusBadges
                        installed={installed}
                        incompatible={incompatible}
                        minRequired={minRequired}
                        highRisk={highRisk}
                      />
                    </div>
                    {/* 描述 */}
                    <p className="text-xs text-zinc-500 line-clamp-1 leading-relaxed mt-0.5">
                      {p.description || p.id}
                    </p>
                    {/* 元信息 */}
                    <div className="flex items-center gap-2 mt-1 text-[10px] text-zinc-600">
                      {p.publisher && <span className="truncate">{p.publisher}</span>}
                      {p.updatedAt && (
                        <>
                          {p.publisher && <span className="text-zinc-700">·</span>}
                          <span>{formatRelativeTime(p.updatedAt)}</span>
                        </>
                      )}
                      {p.category && (
                        <>
                          <span className="text-zinc-700">·</span>
                          <span>#{p.category}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
