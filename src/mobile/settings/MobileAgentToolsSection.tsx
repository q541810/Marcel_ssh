import { useEffect, useState } from 'react';
import type {
  ExperimentalSettings,
  FetchApiProtocol,
  HttpFetchMode,
  SearchApiProtocol,
  WebSearchApiProvider,
  WebSearchEndpoint,
  WebSearchMode,
} from '@/lib/types';
import Toggle from '@/components/ui/Toggle';
import { useSettingsActions } from '@/components/settings/SettingsActionsContext';
import { DEFAULT_EXPERIMENTAL_SETTINGS } from '@/stores/settingsStore';
import { useConnectionStore } from '@/stores/connectionStore';
import { usePrivacyMode } from '@/hooks/usePrivacyMode';
import { formatConnLabel } from '@/lib/privacy';
import {
  CUSTOM_FETCH_DESCRIPTION,
  CUSTOM_FETCH_KEY_DESCRIPTION,
  CUSTOM_FETCH_PRIVATE_DESCRIPTION,
  CUSTOM_FETCH_URL_PLACEHOLDER,
  CUSTOM_URL_PLACEHOLDER,
  DEEPSEEK_FETCH_DESCRIPTION,
  DEEPSEEK_KEY_SHARED_NOTE,
  FETCH_API_PROTOCOLS,
  SEARCH_API_PROTOCOLS,
  TAVILY_FETCH_DESCRIPTION,
  TAVILY_FETCH_KEY_DESCRIPTION,
  WEB_SEARCH_API_PROVIDERS,
  searchKeyDescription,
} from '@/lib/webSearchProviders';
import { useCustomSearchApi } from '@/hooks/useCustomSearchApi';
import { useCustomFetchApi } from '@/hooks/useCustomFetchApi';
import {
  clearToolApiKey,
  saveToolApiKey,
  searchProviderKeySlot,
  useHasToolApiKey,
  type ToolApiKeySlot,
} from '@/lib/toolApiKeys';
import { MobileChoiceGroup as ChoiceGroup } from '@/mobile/ui/MobileChoiceGroup';
import { MobileSettingRow } from './MobileSettingRow';

const SEARCH_MODE_OPTIONS: readonly {
  value: 'html' | 'api';
  label: string;
  desc: string;
}[] = [
  { value: 'html', label: '裸抓 Bing HTML', desc: '零配置，质量一般' },
  { value: 'api', label: '搜索 API', desc: '需自备 Key，质量好' },
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

type MobileFetchMode = 'html' | 'deepseek' | 'tavily' | 'custom';

const FETCH_MODE_OPTIONS: readonly {
  value: MobileFetchMode;
  label: string;
  desc: string;
}[] = [
  { value: 'html', label: '裸 HTTP GET', desc: '零配置，易被站点拦截' },
  { value: 'deepseek', label: 'DeepSeek 抓取', desc: '服务器代抓成 Markdown，需 DeepSeek Key' },
  { value: 'tavily', label: 'Tavily 抓取', desc: '服务器代抓成 Markdown，需 Tavily Key' },
  { value: 'custom', label: '自定义', desc: '接入你自己的抓取服务，兼容 DeepSeek 或 Tavily 格式' },
];

/** 纯 HTTP 的服务端抓取：手机上完全可用（后端 `resolve_fetch_mode` 同一份判断）。 */
function isServerFetchMode(mode: HttpFetchMode | undefined): mode is 'deepseek' | 'tavily' | 'custom' {
  return mode === 'deepseek' || mode === 'tavily' || mode === 'custom';
}

/** 手机端获取方式的 UI 归并：browser（本机不可用的 CDP 模式，可能来自旧版桌面端配置）在 UI 上视为裸 HTTP。 */
export function resolveMobileFetchMode(stored: HttpFetchMode | undefined): MobileFetchMode {
  return isServerFetchMode(stored) ? stored : 'html';
}

/**
 * 计算选择获取方式后应写入的配置 patch，规则同 {@link selectMobileSearchMode}：
 * - 选择「DeepSeek / Tavily 抓取 / 自定义」（纯 HTTP，手机可用）→ 直接写入
 * - 选择「裸 HTTP」→ 仅当原值是服务端抓取（deepseek / tavily / custom）时才写 html；
 *   原值是 browser（桌面端遗留，手机不可用）时保持原样，避免覆盖桌面端的选择
 */
export function selectMobileFetchMode(
  stored: HttpFetchMode | undefined,
  next: MobileFetchMode,
): Partial<ExperimentalSettings> {
  if (next !== 'html') return { httpFetchMode: next };
  if (isServerFetchMode(stored)) return { httpFetchMode: 'html' };
  return {};
}

const KEY_INPUT_CLASS =
  'flex-1 rounded-lg border border-edge bg-field px-3 py-2.5 font-mono text-body text-fg outline-none placeholder:text-fg-tertiary focus:border-indigo-500';

/** 联网工具的 API Key 输入框。已存时回显掩码；失焦即保存；Key 永不回传前端。 */
function ToolApiKeyInput({ slot, placeholder }: { slot: ToolApiKeySlot; placeholder: string }) {
  const hasKey = useHasToolApiKey(slot);
  const [draft, setDraft] = useState('');

  return (
    <div className="mt-2 flex items-center gap-2">
      <input
        type="password"
        value={draft || (hasKey ? '********' : '')}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          void saveToolApiKey(slot, draft).then((saved) => saved && setDraft(''));
        }}
        placeholder={hasKey ? '已保存，输入新 Key 可覆盖' : placeholder}
        autoComplete="off"
        className={KEY_INPUT_CLASS}
      />
      {hasKey && (
        <button
          type="button"
          onClick={() => void clearToolApiKey(slot).then((cleared) => cleared && setDraft(''))}
          className="flex-shrink-0 rounded-lg bg-surface-raised px-3 py-2.5 text-body text-fg active:bg-state-mid"
        >
          清除
        </button>
      )}
    </div>
  );
}

/** Agent 工具能力（联网搜索 / 网页抓取 / 交互可视化 / 多机目标）——与桌面 ToolCapabilitiesSection 对齐的移动端版。 */
export function MobileAgentToolsSection() {
  const { settings, update } = useSettingsActions();
  const connections = useConnectionStore((s) => s.connections);
  const fetchConnections = useConnectionStore((s) => s.fetchConnections);
  // 隐私模式：机器清单里的 user@host:port 也要脱敏（与连接列表同一口径）
  const privacyMode = usePrivacyMode();
  useEffect(() => {
    if (connections.length === 0) void fetchConnections();
  }, [connections.length, fetchConnections]);

  const experimental: ExperimentalSettings = {
    ...DEFAULT_EXPERIMENTAL_SETTINGS,
    ...(settings.experimentalSettings ?? {}),
  };

  const updateExperimental = (patch: Partial<ExperimentalSettings>) => {
    update({ experimentalSettings: { ...experimental, ...patch } });
  };

  // 手机端无本机浏览器（CDP）能力：设置值 browser（桌面端遗留）
  // 在 UI 上归并为「裸抓」展示，但保持已保存的配置值不变，避免覆盖。
  const storedMode: WebSearchMode = experimental.webSearchMode ?? 'browser';
  const isApiMode = resolveMobileSearchMode(storedMode) === 'api';
  const apiProvider: WebSearchApiProvider = experimental.webSearchApiProvider ?? 'brave';
  const syncedBrowser = isSyncedBrowserMode(storedMode);

  const selectSearchMode = (mode: 'html' | 'api') => {
    const patch = selectMobileSearchMode(storedMode, mode);
    if (Object.keys(patch).length > 0) updateExperimental(patch);
  };

  const searchKeySlot = searchProviderKeySlot(apiProvider);
  const customFetchForm = useCustomFetchApi(
    experimental.httpFetchCustom ?? { url: '', protocol: 'deepseek', sendPrivate: false },
    (next) => updateExperimental({ httpFetchCustom: next }),
  );
  const customForm = useCustomSearchApi(
    experimental.webSearchCustom ?? { url: '', protocol: 'brave' },
    (next) => updateExperimental({ webSearchCustom: next }),
  );

  // 获取方式同理：browser（桌面端遗留）在 UI 上归并为裸 HTTP，保存的配置值不动。
  const fetchMode = resolveMobileFetchMode(experimental.httpFetchMode);
  const selectFetchMode = (mode: MobileFetchMode) => {
    const patch = selectMobileFetchMode(experimental.httpFetchMode, mode);
    if (Object.keys(patch).length > 0) updateExperimental(patch);
  };

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
            <p className="mt-2 rounded-lg bg-amber-950/30 px-3 py-2 text-meta leading-relaxed text-amber-200/90">
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
              options={WEB_SEARCH_API_PROVIDERS}
              value={apiProvider}
              onChange={(v) =>
                updateExperimental({ webSearchApiProvider: v as WebSearchApiProvider })
              }
            />
          </MobileSettingRow>

          {apiProvider === 'custom' && (
            <>
              <MobileSettingRow
                label="自定义接口地址"
                description="你自己的搜索服务的完整地址（不是 OpenAI 格式）。搜索词会发到这个地址，请只填你信任的服务"
              >
                <input
                  type="url"
                  inputMode="url"
                  value={customForm.urlDraft}
                  onChange={(e) => customForm.setUrlDraft(e.target.value)}
                  onBlur={customForm.commitUrl}
                  placeholder={CUSTOM_URL_PLACEHOLDER}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  className={`mt-2 w-full ${KEY_INPUT_CLASS}`}
                />
                {customForm.check.error && (
                  <p className="mt-1.5 text-meta leading-relaxed text-red-400">{customForm.check.error}</p>
                )}
                {customForm.check.warning && (
                  <p className="mt-1.5 text-meta leading-relaxed text-amber-300/90">
                    {customForm.check.warning}
                  </p>
                )}
              </MobileSettingRow>

              <MobileSettingRow label="兼容的协议" description="选择你的服务兼容哪家的接口格式">
                <ChoiceGroup
                  options={SEARCH_API_PROTOCOLS.map(({ value, label, hint }) => ({
                    value,
                    label,
                    desc: hint,
                  }))}
                  value={customForm.protocol}
                  onChange={(v) => customForm.setProtocol(v as SearchApiProtocol)}
                />
              </MobileSettingRow>
            </>
          )}

          <MobileSettingRow
            label={
              apiProvider === 'deepseek'
                ? 'DeepSeek API Key'
                : apiProvider === 'custom'
                  ? 'API Key（可选）'
                  : '搜索 API Key'
            }
            description={searchKeyDescription(apiProvider)}
          >
            {/* key = 槽位：切换提供商时各用各的草稿，不把上一个提供商的输入带过去 */}
            <ToolApiKeyInput
              key={searchKeySlot}
              slot={searchKeySlot}
              placeholder={
                apiProvider === 'deepseek'
                  ? '输入 DeepSeek API Key'
                  : apiProvider === 'custom'
                    ? '可留空（自建服务无需 Key）'
                    : '输入搜索 API Key'
              }
            />
          </MobileSettingRow>
        </>
      )}

      <MobileSettingRow
        label="网页获取"
        description="允许 Agent 使用 http_get 工具获取网页内容；手机端没有本机浏览器，默认用裸 HTTP 抓取"
        trailing={
          <Toggle
            checked={experimental.enableHttpFetch}
            onChange={(checked) => updateExperimental({ enableHttpFetch: checked })}
          />
        }
      />

      {experimental.enableHttpFetch && (
        <>
          <MobileSettingRow
            label="获取方式"
            description="DeepSeek / Tavily 抓取或自定义服务失败时会自动降级为本机裸 HTTP GET，并在结果中标注「已降级」"
          >
            <ChoiceGroup options={FETCH_MODE_OPTIONS} value={fetchMode} onChange={selectFetchMode} />
          </MobileSettingRow>

          {fetchMode === 'deepseek' && (
            <MobileSettingRow
              label="DeepSeek API Key"
              description={`${DEEPSEEK_FETCH_DESCRIPTION}${DEEPSEEK_KEY_SHARED_NOTE}`}
            >
              <ToolApiKeyInput slot="deepseek" placeholder="输入 DeepSeek API Key" />
            </MobileSettingRow>
          )}

          {fetchMode === 'tavily' && (
            <MobileSettingRow
              label="Tavily API Key"
              description={`${TAVILY_FETCH_DESCRIPTION}${TAVILY_FETCH_KEY_DESCRIPTION}`}
            >
              <ToolApiKeyInput
                slot="tavilyFetch"
                placeholder={
                  apiProvider === 'tavily' ? '留空则沿用 Tavily 搜索的 Key' : '输入 Tavily API Key'
                }
              />
            </MobileSettingRow>
          )}

          {fetchMode === 'custom' && (
            <>
              <MobileSettingRow label="自定义接口地址" description={CUSTOM_FETCH_DESCRIPTION}>
                <input
                  type="url"
                  inputMode="url"
                  value={customFetchForm.urlDraft}
                  onChange={(e) => customFetchForm.setUrlDraft(e.target.value)}
                  onBlur={customFetchForm.commitUrl}
                  placeholder={CUSTOM_FETCH_URL_PLACEHOLDER}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  className={`mt-2 w-full ${KEY_INPUT_CLASS}`}
                />
                {customFetchForm.check.error && (
                  <p className="mt-1.5 text-meta leading-relaxed text-red-400">
                    {customFetchForm.check.error}
                  </p>
                )}
                {customFetchForm.check.warning && (
                  <p className="mt-1.5 text-meta leading-relaxed text-amber-300/90">
                    {customFetchForm.check.warning}
                  </p>
                )}
              </MobileSettingRow>

              <MobileSettingRow label="兼容的协议" description="选择你的服务兼容哪家的接口格式">
                <ChoiceGroup
                  options={FETCH_API_PROTOCOLS.map(({ value, label, hint }) => ({
                    value,
                    label,
                    desc: hint,
                  }))}
                  value={customFetchForm.protocol}
                  onChange={(v) => customFetchForm.setProtocol(v as FetchApiProtocol)}
                />
              </MobileSettingRow>

              <MobileSettingRow label="API Key（可选）" description={CUSTOM_FETCH_KEY_DESCRIPTION}>
                <ToolApiKeyInput slot="customFetch" placeholder="可留空（自建服务无需 Key）" />
              </MobileSettingRow>

              <MobileSettingRow
                label="内网地址也交给它抓"
                description={CUSTOM_FETCH_PRIVATE_DESCRIPTION}
                trailing={
                  <Toggle
                    checked={customFetchForm.sendPrivate}
                    onChange={customFetchForm.setSendPrivate}
                  />
                }
              />
            </>
          )}
        </>
      )}

      <MobileSettingRow
        label="交互可视化"
        description="允许 Agent 将图表、对比面板、模拟器等交互内容直接展示在对话中"
        trailing={
          <Toggle
            checked={experimental.enableHtmlRender ?? true}
            onChange={(checked) => updateExperimental({ enableHtmlRender: checked })}
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
            className="mt-2 w-full rounded-xl min-h-11 border border-edge bg-surface/50 px-3 py-3 text-body text-fg-secondary active:bg-state-soft"
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
                    className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left pressable ${
                      active
                        ? 'bg-indigo-500/10 text-indigo-100'
                        : 'bg-surface/50 text-fg-secondary'
                    }`}
                  >
                    <span
                      className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border ${
                        active
                          ? 'border-indigo-400 bg-indigo-500'
                          : 'border-edge-strong bg-transparent'
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
                      <span className="block truncate text-meta font-medium">
                        {conn.name}
                      </span>
                      <span className="block truncate text-caption text-fg-tertiary">
                        {conn.group || '未分组'} ·{' '}
                        {formatConnLabel(
                          conn.username,
                          conn.host,
                          conn.port,
                          privacyMode,
                        )}
                      </span>
                    </span>
                  </button>
                );
              })}
          </div>
        )}
        <p className="mt-2 text-caption leading-relaxed text-fg-tertiary">
          集合为空 = 仅当前机可执行。upload/download 本机中转工具在手机端不可用。
        </p>
      </MobileSettingRow>
    </div>
  );
}
