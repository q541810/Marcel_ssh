import { useEffect, useState } from 'react';
import type {
  ExperimentalSettings,
  WebSearchApiProvider,
  WebSearchEndpoint,
  WebSearchMode,
} from '@/lib/types';
import Toggle from '@/components/ui/Toggle';
import { useSettingsActions } from '@/components/settings/SettingsActionsContext';
import { useSettingsStore } from '@/stores/settingsStore';
import { useConnectionStore } from '@/stores/connectionStore';
import * as tauri from '@/lib/tauri';
import { MobileSettingRow } from './MobileSettingRow';

const DEFAULT_EXPERIMENTAL: ExperimentalSettings = {
  enableWebSearch: true,
  enableHttpFetch: true,
  enableCloudPage: false,
  webSearchMode: 'browser',
  webSearchApiProvider: 'brave',
  webSearchEndpoint: 'cn',
  httpFetchMode: 'browser',
  enableHtmlRender: true,
  multiHostConnectionIds: [],
};

const SEARCH_MODE_OPTIONS: readonly {
  value: 'html' | 'api';
  label: string;
  desc: string;
}[] = [
  { value: 'html', label: '裸抓 Bing HTML', desc: '零配置，质量一般' },
  { value: 'api', label: '搜索 API', desc: '需自备 Key，质量好' },
];

const PROVIDER_OPTIONS: readonly { value: WebSearchApiProvider; label: string }[] = [
  { value: 'brave', label: 'Brave Search' },
  { value: 'tavily', label: 'Tavily' },
];

const ENDPOINT_OPTIONS: readonly { value: WebSearchEndpoint; label: string; desc?: string }[] = [
  { value: 'cn', label: 'cn.bing.com', desc: '中国区节点，中英文混合查询更稳定（推荐）' },
  { value: 'www', label: 'www.bing.com', desc: '国际节点' },
];

/** 手机端搜索方式的 UI 归并：browser（本机不可用的 CDP 模式，可能来自旧版桌面端配置）在 UI 上视为裸抓。 */
export function resolveMobileSearchMode(
  stored: WebSearchMode | undefined,
): 'html' | 'api' {
  return stored === 'api' ? 'api' : 'html';
}

/** 原配置是否为手机端不可用的 browser 模式（用于展示降级说明）。 */
export function isSyncedBrowserMode(stored: WebSearchMode | undefined): boolean {
  return stored === 'browser';
}

/**
 * 计算选择搜索方式后应写入的配置 patch：
 * - 选择「搜索 API」→ 直接写 api
 * - 选择「裸抓」→ 仅当原值是 api 时才写 html；
 *   原值是 browser（桌面端遗留，手机不可用）时保持原样，避免覆盖
 */
export function selectMobileSearchMode(
  stored: WebSearchMode | undefined,
  next: 'html' | 'api',
): Partial<ExperimentalSettings> {
  if (next === 'api') return { webSearchMode: 'api' };
  if (stored === 'api') return { webSearchMode: 'html' };
  return {};
}

function ChoiceGroup<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string; desc?: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="mt-2 grid grid-cols-2 gap-2">
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={`rounded-xl border px-3 py-2.5 text-left transition-colors duration-100 active:scale-[0.99] ${
              active
                ? 'border-indigo-500 bg-indigo-500/10'
                : 'border-zinc-700 bg-zinc-800/60'
            }`}
          >
            <div
              className={`text-sm font-medium ${
                active ? 'text-indigo-200' : 'text-zinc-300'
              }`}
            >
              {o.label}
            </div>
            {o.desc && (
              <div className="mt-0.5 text-[11px] text-zinc-500">{o.desc}</div>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Agent 工具能力（联网搜索 / 网页抓取 / 多机目标）——与桌面 ToolCapabilitiesSection 对齐的移动端版。 */
export function MobileAgentToolsSection() {
  const { settings, update } = useSettingsActions();
  const hasWebSearchApiKey = useSettingsStore((s) => s.hasWebSearchApiKey);
  const [searchKeyDraft, setSearchKeyDraft] = useState('');
  const connections = useConnectionStore((s) => s.connections);
  const fetchConnections = useConnectionStore((s) => s.fetchConnections);
  useEffect(() => {
    if (connections.length === 0) void fetchConnections();
  }, [connections.length, fetchConnections]);

  const experimental: ExperimentalSettings = {
    ...DEFAULT_EXPERIMENTAL,
    ...(settings.experimentalSettings ?? {}),
  };

  const updateExperimental = (patch: Partial<ExperimentalSettings>) => {
    update({ experimentalSettings: { ...experimental, ...patch } });
  };

  // 手机端无本机浏览器（CDP）能力：设置值 browser（桌面端遗留）
  // 在 UI 上归并为「裸抓」展示，但保持已保存的配置值不变，避免覆盖。
  const storedMode: WebSearchMode = experimental.webSearchMode ?? 'browser';
  const isApiMode = resolveMobileSearchMode(storedMode) === 'api';
  const syncedBrowser = isSyncedBrowserMode(storedMode);

  const selectSearchMode = (mode: 'html' | 'api') => {
    const patch = selectMobileSearchMode(storedMode, mode);
    if (Object.keys(patch).length > 0) updateExperimental(patch);
  };

  const persistSearchKey = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || trimmed.includes('******') || trimmed === '********') return;
    try {
      await tauri.saveWebSearchApiKey(trimmed);
      useSettingsStore.setState({ hasWebSearchApiKey: true });
      setSearchKeyDraft('');
    } catch (err) {
      console.error('保存搜索 API Key 失败:', err);
    }
  };

  const clearSearchKey = async () => {
    try {
      await tauri.deleteWebSearchApiKey();
      useSettingsStore.setState({ hasWebSearchApiKey: false });
      setSearchKeyDraft('');
    } catch (err) {
      console.error('清除搜索 API Key 失败:', err);
    }
  };

  const inputClass =
    'flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-indigo-500';

  // 多机白名单（与桌面 / Agent 顶栏 Sheet 同一份数据）
  const multiHostIds = experimental.multiHostConnectionIds ?? [];
  const toggleMultiHost = (id: string) => {
    const next = multiHostIds.includes(id)
      ? multiHostIds.filter((x) => x !== id)
      : [...multiHostIds, id];
    updateExperimental({ multiHostConnectionIds: next });
  };

  return (
    <div className="flex flex-col gap-2">
      <MobileSettingRow
        label="联网搜索"
        description="允许 Agent 使用 web_search 工具搜索互联网"
        trailing={
          <Toggle
            checked={experimental.enableWebSearch}
            onChange={(checked) => updateExperimental({ enableWebSearch: checked })}
          />
        }
      />

      {experimental.enableWebSearch && (
        <MobileSettingRow
          label="搜索方式"
          description="手机端无法启动本机浏览器，仅支持裸抓与搜索 API。桌面端若本机浏览器失败，会自动重试后降级为裸抓，并在结果中标注「已降级」"
        >
          <ChoiceGroup
            options={SEARCH_MODE_OPTIONS}
            value={isApiMode ? 'api' : 'html'}
            onChange={selectSearchMode}
          />
          {syncedBrowser && (
            <p className="mt-2 rounded-lg bg-amber-950/30 px-3 py-2 text-xs leading-relaxed text-amber-200/90">
              本机浏览器模式在手机端不可用，已自动降级为裸抓
              Bing HTML；如搜索结果质量不佳，可切换为搜索 API。
            </p>
          )}
        </MobileSettingRow>
      )}

      {experimental.enableWebSearch && !isApiMode && (
        <MobileSettingRow
          label="搜索端点"
          description="裸抓 / 浏览器模式使用的 Bing 域名"
        >
          <ChoiceGroup
            options={ENDPOINT_OPTIONS}
            value={experimental.webSearchEndpoint ?? 'cn'}
            onChange={(v) =>
              updateExperimental({ webSearchEndpoint: v as WebSearchEndpoint })
            }
          />
        </MobileSettingRow>
      )}

      {experimental.enableWebSearch && isApiMode && (
        <>
          <MobileSettingRow label="搜索 API 提供商" description="独立搜索引擎 HTTP API（非 OpenAI 格式）">
            <ChoiceGroup
              options={PROVIDER_OPTIONS}
              value={experimental.webSearchApiProvider ?? 'brave'}
              onChange={(v) =>
                updateExperimental({ webSearchApiProvider: v as WebSearchApiProvider })
              }
            />
          </MobileSettingRow>

          <MobileSettingRow
            label="搜索 API Key"
            description="加密保存在本设备，不会写入配置文件"
          >
            <div className="mt-2 flex items-center gap-2">
              <input
                type="password"
                value={searchKeyDraft || (hasWebSearchApiKey ? '********' : '')}
                onChange={(e) => setSearchKeyDraft(e.target.value)}
                onBlur={() => {
                  void persistSearchKey(searchKeyDraft);
                }}
                placeholder={hasWebSearchApiKey ? '已保存，输入新 Key 可覆盖' : '输入搜索 API Key'}
                autoComplete="off"
                className={inputClass}
              />
              {hasWebSearchApiKey && (
                <button
                  type="button"
                  onClick={() => void clearSearchKey()}
                  className="flex-shrink-0 rounded-lg bg-zinc-800 px-3 py-2.5 text-sm text-zinc-200 active:bg-zinc-700"
                >
                  清除
                </button>
              )}
            </div>
          </MobileSettingRow>
        </>
      )}

      <MobileSettingRow
        label="网页获取"
        description="允许 Agent 使用 http_get 工具获取网页内容；手机端固定使用裸 HTTP 抓取"
        trailing={
          <Toggle
            checked={experimental.enableHttpFetch}
            onChange={(checked) => updateExperimental({ enableHttpFetch: checked })}
          />
        }
      />

      <MobileSettingRow
        label="多机操控目标"
        description="勾选后 Agent 可携带 host 跨机执行 bash / 子agent；未勾选的机器不会被 host 指定。当前会话所在机器始终可执行，无需勾选。"
      >
        {connections.length === 0 ? (
          <button
            type="button"
            onClick={() => void fetchConnections()}
            className="mt-2 w-full rounded-xl border border-zinc-700 bg-zinc-900/50 px-3 py-3 text-xs text-zinc-400 active:bg-zinc-800"
          >
            加载已保存连接
          </button>
        ) : (
          <div className="mt-2 space-y-1">
            {connections
              .slice()
              .sort(
                (a, b) =>
                  (a.group || '').localeCompare(b.group || '') ||
                  a.name.localeCompare(b.name),
              )
              .map((conn) => {
                const active = multiHostIds.includes(conn.id);
                return (
                  <button
                    key={conn.id}
                    type="button"
                    onClick={() => toggleMultiHost(conn.id)}
                    className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-colors active:scale-[0.99] ${
                      active
                        ? 'bg-indigo-500/10 text-indigo-100'
                        : 'bg-zinc-900/50 text-zinc-300'
                    }`}
                  >
                    <span
                      className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border ${
                        active
                          ? 'border-indigo-400 bg-indigo-500'
                          : 'border-zinc-600 bg-transparent'
                      }`}
                    >
                      {active && (
                        <svg
                          className="h-2.5 w-2.5 text-white"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={3.5}
                            d="M5 13l4 4L19 7"
                          />
                        </svg>
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">
                        {conn.name}
                      </span>
                      <span className="block truncate text-[10px] text-zinc-500">
                        {conn.group || '未分组'} · {conn.username}@{conn.host}:
                        {conn.port}
                      </span>
                    </span>
                  </button>
                );
              })}
          </div>
        )}
        <p className="mt-2 text-[10px] leading-relaxed text-zinc-500">
          集合为空 = 仅当前机可执行。upload/download 本机中转工具在手机端不可用。
        </p>
      </MobileSettingRow>
    </div>
  );
}
