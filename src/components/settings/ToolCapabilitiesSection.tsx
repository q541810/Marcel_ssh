import { useState, useEffect } from 'react';
import { Check } from 'lucide-react';
import type {
  ExperimentalSettings,
  FetchApiProtocol,
  HttpFetchMode,
  SearchApiProtocol,
  WebSearchApiProvider,
  WebSearchEndpoint,
  WebSearchMode,
} from '@/lib/types';
import Button from '@/components/ui/Button';
import Toggle from '@/components/ui/Toggle';
import Select from '@/components/ui/Select';
import { Card, SettingItem } from './helpers';
import { useSettingsActions } from './SettingsActionsContext';
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

/** 多机操控的机器集合复选。数据源 = 已保存连接；勾选结果直接进
 *  `experimentalSettings.multiHostConnectionIds`（与后端白名单同一份）。 */
function MachinePicker({
  checkedIds,
  onChange,
}: {
  checkedIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const connections = useConnectionStore((s) => s.connections);
  const fetchConnections = useConnectionStore((s) => s.fetchConnections);
  // 隐私模式：机器清单里的 user@host:port 也要脱敏（与连接列表同一口径）
  const privacyMode = usePrivacyMode();

  // 挂载时拉取一次连接列表（渲染期不触发副作用——空列表时确保有数据可勾选）。
  useEffect(() => {
    if (connections.length === 0) void fetchConnections();
  }, [connections.length, fetchConnections]);

  const toggle = (id: string) => {
    if (checkedIds.includes(id)) {
      onChange(checkedIds.filter((x) => x !== id));
    } else {
      onChange([...checkedIds, id]);
    }
  };

  const sorted = [...connections].sort((a, b) =>
    (a.group || '').localeCompare(b.group || '') || a.name.localeCompare(b.name),
  );

  return (
    <div className="flex flex-col gap-2 w-full max-h-56 overflow-y-auto">
      {connections.length === 0 && (
        <div className="text-meta text-fg-tertiary py-2">
          暂无已保存的连接。请先在连接列表添加机器。
        </div>
      )}
      {sorted.map((conn) => {
        const active = checkedIds.includes(conn.id);
        return (
          <button
            key={conn.id}
            type="button"
            onClick={() => toggle(conn.id)}
            className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
              active
                ? 'border-indigo-500 bg-indigo-500/10 text-indigo-100'
                : 'border-edge bg-surface-raised/40 text-fg-secondary hover:border-edge-strong'
            }`}
          >
            <span
              className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border ${
                active ? 'border-indigo-400 bg-indigo-500' : 'border-edge-strong bg-transparent'
              }`}
            >
              {active && (
                <Check size={12} strokeWidth={2} className="text-white" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body font-medium">{conn.name}</span>
              <span className="block truncate text-caption text-fg-tertiary">
                {conn.group || '未分组'} ·{' '}
                {formatConnLabel(conn.username, conn.host, conn.port, privacyMode)}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** 联网工具的 API Key 输入框。已存时回显掩码；失焦即保存；Key 永不回传前端。 */
function ToolApiKeyInput({ slot, placeholder }: { slot: ToolApiKeySlot; placeholder: string }) {
  const hasKey = useHasToolApiKey(slot);
  const [draft, setDraft] = useState('');

  return (
    <div className="flex-1 flex gap-2 items-center">
      <input
        type="password"
        value={draft || (hasKey ? '********' : '')}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          void saveToolApiKey(slot, draft).then((saved) => saved && setDraft(''));
        }}
        placeholder={hasKey ? '已保存，输入新 Key 可覆盖' : placeholder}
        autoComplete="off"
        className="flex-1 rounded-lg bg-field border border-edge px-3 py-2 text-body font-mono text-fg placeholder:text-fg-tertiary focus:outline-none focus:border-indigo-500"
      />
      {hasKey && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void clearToolApiKey(slot).then((cleared) => cleared && setDraft(''))}
        >
          清除
        </Button>
      )}
    </div>
  );
}

export function ToolCapabilitiesSection() {
  const { settings, update } = useSettingsActions();

  const experimental: ExperimentalSettings = {
    ...DEFAULT_EXPERIMENTAL_SETTINGS,
    ...(settings.experimentalSettings ?? {}),
  };

  const updateExperimental = (patch: Partial<ExperimentalSettings>) => {
    update({ experimentalSettings: { ...experimental, ...patch } });
  };

  const searchMode = experimental.webSearchMode ?? 'browser';
  const apiProvider = experimental.webSearchApiProvider ?? 'brave';
  const searchEndpoint = experimental.webSearchEndpoint ?? 'cn';
  const httpFetchMode = experimental.httpFetchMode ?? 'browser';

  const searchKeySlot = searchProviderKeySlot(apiProvider);
  const customForm = useCustomSearchApi(
    experimental.webSearchCustom ?? { url: '', protocol: 'brave' },
    (next) => updateExperimental({ webSearchCustom: next }),
  );
  const customFetchForm = useCustomFetchApi(
    experimental.httpFetchCustom ?? { url: '', protocol: 'deepseek', sendPrivate: false },
    (next) => updateExperimental({ httpFetchCustom: next }),
  );
  const protocolHint = SEARCH_API_PROTOCOLS.find((p) => p.value === customForm.protocol)?.hint;
  const fetchProtocolHint = FETCH_API_PROTOCOLS.find(
    (p) => p.value === customFetchForm.protocol,
  )?.hint;

  return (
    <Card id="settings-experimental" title="Agent 工具" description="控制 Agent 可调用的工具能力和系统集成">
      <SettingItem
        id="exp-websearch"
        label="联网搜索"
        description="允许 Agent 使用 web_search 工具搜索互联网"
        sectionId="settings-experimental"
        keywords={['web', 'search', '搜索', '工具能力', 'Agent 工具']}
      >
        <Toggle
          checked={experimental.enableWebSearch}
          onChange={(checked) => updateExperimental({ enableWebSearch: checked })}
        />
      </SettingItem>

      {experimental.enableWebSearch && (
        <>
          <SettingItem
            id="exp-websearch-mode"
            label="搜索方式"
            description="本机浏览器效果最好；搜索 API 需自备 Key；裸抓零配置但质量一般。本机浏览器失败时会自动重试一次，仍失败则降级为裸抓，并在结果中标注「已降级」"
            sectionId="settings-experimental"
            keywords={['web', 'search', 'browser', 'api', 'bing', '搜索方式', '浏览器', '降级']}
          >
            <Select
              value={searchMode}
              onChange={(v) => updateExperimental({ webSearchMode: v as WebSearchMode })}
              options={[
                { value: 'browser', label: '本机浏览器（推荐）' },
                { value: 'api', label: '搜索 API' },
                { value: 'html', label: '裸抓 Bing HTML' },
              ]}
              className="w-52"
            />
          </SettingItem>

          {searchMode !== 'api' && (
            <SettingItem
              id="exp-websearch-endpoint"
              label="搜索端点"
              description="cn.bing.com 中国区节点对混合中英文查询更稳定（默认）；www.bing.com 为国际节点"
              sectionId="settings-experimental"
              keywords={['web', 'search', 'bing', 'cn', 'www', '端点']}
            >
              <Select
                value={searchEndpoint}
                onChange={(v) => updateExperimental({ webSearchEndpoint: v as WebSearchEndpoint })}
                options={[
                  { value: 'cn', label: 'cn.bing.com（推荐）' },
                  { value: 'www', label: 'www.bing.com' },
                ]}
                className="w-52"
              />
            </SettingItem>
          )}

          {searchMode === 'api' && (
            <>
              <SettingItem
                id="exp-websearch-api-provider"
                label="搜索 API 提供商"
                description="独立搜索引擎 HTTP API（非 OpenAI 格式）"
                sectionId="settings-experimental"
                keywords={['brave', 'tavily', 'deepseek', 'serpapi', '搜索 API']}
              >
                <Select
                  value={apiProvider}
                  onChange={(v) => updateExperimental({ webSearchApiProvider: v as WebSearchApiProvider })}
                  options={[...WEB_SEARCH_API_PROVIDERS]}
                  className="w-52"
                />
              </SettingItem>
              {apiProvider === 'custom' && (
                <>
                  <SettingItem
                    id="exp-websearch-custom-url"
                    label="自定义接口地址"
                    description="你自己的搜索服务的完整地址（不是 OpenAI 格式）。搜索词会发到这个地址，请只填你信任的服务"
                    sectionId="settings-experimental"
                    keywords={['custom', 'url', '自定义', '地址', '自建', 'searxng']}
                  >
                    <div className="flex flex-1 flex-col gap-1">
                      <input
                        type="url"
                        value={customForm.urlDraft}
                        onChange={(e) => customForm.setUrlDraft(e.target.value)}
                        onBlur={customForm.commitUrl}
                        placeholder={CUSTOM_URL_PLACEHOLDER}
                        autoComplete="off"
                        spellCheck={false}
                        className="w-full rounded-lg bg-field border border-edge px-3 py-2 text-body font-mono text-fg placeholder:text-fg-tertiary focus:outline-none focus:border-indigo-500"
                      />
                      {customForm.check.error && (
                        <p className="text-meta text-red-400">{customForm.check.error}</p>
                      )}
                      {customForm.check.warning && (
                        <p className="text-meta text-amber-300/90">{customForm.check.warning}</p>
                      )}
                    </div>
                  </SettingItem>
                  <SettingItem
                    id="exp-websearch-custom-protocol"
                    label="兼容的协议"
                    description={protocolHint ?? '选择你的服务兼容哪家的接口格式'}
                    sectionId="settings-experimental"
                    keywords={['protocol', '协议', '兼容', 'brave', 'tavily', 'deepseek']}
                  >
                    <Select
                      value={customForm.protocol}
                      onChange={(v) => customForm.setProtocol(v as SearchApiProtocol)}
                      options={SEARCH_API_PROTOCOLS.map(({ value, label }) => ({ value, label }))}
                      className="w-52"
                    />
                  </SettingItem>
                </>
              )}
              <SettingItem
                id="exp-websearch-api-key"
                label={
                  apiProvider === 'deepseek'
                    ? 'DeepSeek API Key'
                    : apiProvider === 'custom'
                      ? 'API Key（可选）'
                      : '搜索 API Key'
                }
                description={searchKeyDescription(apiProvider)}
                sectionId="settings-experimental"
                keywords={['key', '密钥', 'brave', 'tavily', 'deepseek', '自定义']}
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
              </SettingItem>
            </>
          )}
        </>
      )}

      <SettingItem
        id="exp-httpfetch"
        label="网页获取"
        description="允许 Agent 使用 http_get 工具获取网页内容"
        sectionId="settings-experimental"
        keywords={['http', 'fetch', '网页', '工具能力', 'Agent 工具']}
      >
        <Toggle
          checked={experimental.enableHttpFetch}
          onChange={(checked) => updateExperimental({ enableHttpFetch: checked })}
        />
      </SettingItem>

      {experimental.enableHttpFetch && (
        <>
          <SettingItem
            id="exp-httpfetch-mode"
            label="获取方式"
            description="本机浏览器渲染 DOM（推荐）；裸 HTTP 更快但易被站点拦截；DeepSeek / Tavily 抓取由对应服务器代抓并转成 Markdown；自定义可接入你自己的抓取服务（兼容 DeepSeek 或 Tavily 格式）。浏览器或远端服务失败时会自动降级为本机裸 HTTP GET，并在结果中标注「已降级」"
            sectionId="settings-experimental"
            keywords={['http', 'fetch', 'browser', 'html', 'deepseek', 'tavily', 'custom', '自定义', '网页获取', '浏览器', '降级']}
          >
            <Select
              value={httpFetchMode}
              onChange={(v) => updateExperimental({ httpFetchMode: v as HttpFetchMode })}
              options={[
                { value: 'browser', label: '本机浏览器（推荐）' },
                { value: 'html', label: '裸 HTTP GET' },
                { value: 'deepseek', label: 'DeepSeek 抓取' },
                { value: 'tavily', label: 'Tavily 抓取' },
                { value: 'custom', label: '自定义' },
              ]}
              className="w-52"
            />
          </SettingItem>

          {httpFetchMode === 'deepseek' && (
            <SettingItem
              id="exp-httpfetch-deepseek-key"
              label="DeepSeek API Key"
              description={`${DEEPSEEK_FETCH_DESCRIPTION}${DEEPSEEK_KEY_SHARED_NOTE}`}
              sectionId="settings-experimental"
              keywords={['key', '密钥', 'deepseek', '网页获取']}
            >
              <ToolApiKeyInput slot="deepseek" placeholder="输入 DeepSeek API Key" />
            </SettingItem>
          )}

          {httpFetchMode === 'tavily' && (
            <SettingItem
              id="exp-httpfetch-tavily-key"
              label="Tavily API Key"
              description={`${TAVILY_FETCH_DESCRIPTION}${TAVILY_FETCH_KEY_DESCRIPTION}`}
              sectionId="settings-experimental"
              keywords={['key', '密钥', 'tavily', '网页获取']}
            >
              <ToolApiKeyInput
                slot="tavilyFetch"
                placeholder={
                  apiProvider === 'tavily' ? '留空则沿用 Tavily 搜索的 Key' : '输入 Tavily API Key'
                }
              />
            </SettingItem>
          )}

          {httpFetchMode === 'custom' && (
            <>
              <SettingItem
                id="exp-httpfetch-custom-url"
                label="自定义接口地址"
                description={CUSTOM_FETCH_DESCRIPTION}
                sectionId="settings-experimental"
                keywords={['custom', 'url', '自定义', '地址', '自建', '网页获取']}
              >
                <div className="flex flex-1 flex-col gap-1">
                  <input
                    type="url"
                    value={customFetchForm.urlDraft}
                    onChange={(e) => customFetchForm.setUrlDraft(e.target.value)}
                    onBlur={customFetchForm.commitUrl}
                    placeholder={CUSTOM_FETCH_URL_PLACEHOLDER}
                    autoComplete="off"
                    spellCheck={false}
                    className="w-full rounded-lg bg-field border border-edge px-3 py-2 text-body font-mono text-fg placeholder:text-fg-tertiary focus:outline-none focus:border-indigo-500"
                  />
                  {customFetchForm.check.error && (
                    <p className="text-meta text-red-400">{customFetchForm.check.error}</p>
                  )}
                  {customFetchForm.check.warning && (
                    <p className="text-meta text-amber-300/90">{customFetchForm.check.warning}</p>
                  )}
                </div>
              </SettingItem>
              <SettingItem
                id="exp-httpfetch-custom-protocol"
                label="兼容的协议"
                description={fetchProtocolHint ?? '选择你的服务兼容哪家的接口格式'}
                sectionId="settings-experimental"
                keywords={['protocol', '协议', '兼容', 'deepseek', 'tavily', '网页获取']}
              >
                <Select
                  value={customFetchForm.protocol}
                  onChange={(v) => customFetchForm.setProtocol(v as FetchApiProtocol)}
                  options={FETCH_API_PROTOCOLS.map(({ value, label }) => ({ value, label }))}
                  className="w-52"
                />
              </SettingItem>
              <SettingItem
                id="exp-httpfetch-custom-key"
                label="API Key（可选）"
                description={CUSTOM_FETCH_KEY_DESCRIPTION}
                sectionId="settings-experimental"
                keywords={['key', '密钥', '自定义', '网页获取']}
              >
                <ToolApiKeyInput slot="customFetch" placeholder="可留空（自建服务无需 Key）" />
              </SettingItem>
              <SettingItem
                id="exp-httpfetch-custom-private"
                label="内网地址也交给它抓"
                description={CUSTOM_FETCH_PRIVATE_DESCRIPTION}
                sectionId="settings-experimental"
                keywords={['private', 'lan', '内网', '本机', '隐私', '网页获取']}
              >
                <Toggle
                  checked={customFetchForm.sendPrivate}
                  onChange={customFetchForm.setSendPrivate}
                />
              </SettingItem>
            </>
          )}
        </>
      )}

      <SettingItem
        id="exp-cloudpage"
        label="云原神"
        description="允许 Agent 打开云原神页面"
        sectionId="settings-experimental"
        keywords={['cloud', 'genshin', '云原神', '工具能力', 'Agent 工具']}
      >
        <Toggle
          checked={experimental.enableCloudPage}
          onChange={(checked) => updateExperimental({ enableCloudPage: checked })}
        />
      </SettingItem>
      <SettingItem
        id="exp-htmlrender"
        label="交互可视化"
        description="允许 Agent 将模拟器、图表、对比面板等交互内容直接展示在对话中"
        sectionId="settings-experimental"
        keywords={['html', 'card', 'render', '交互', '卡片', 'Agent 工具']}
      >
        <Toggle
          checked={experimental.enableHtmlRender ?? true}
          onChange={(checked) => updateExperimental({ enableHtmlRender: checked })}
        />
      </SettingItem>

      <SettingItem
        id="exp-multihost-set"
        label="可跨机目标机器"
        description="勾选后 Agent 可携带 host 跨机执行 bash / 传输 / 子agent；未勾选的机器不会被 host 指定（当前会话所在机器始终可执行，无需勾选）。多机操控双端恒开启"
        sectionId="settings-experimental"
        keywords={['multi', 'host', '机器', '集合', '勾选', '跨机', '目标']}
      >
        <MachinePicker
          checkedIds={experimental.multiHostConnectionIds ?? []}
          onChange={(ids) => updateExperimental({ multiHostConnectionIds: ids })}
        />
      </SettingItem>
    </Card>
  );
}
