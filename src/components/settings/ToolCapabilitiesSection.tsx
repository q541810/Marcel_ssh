import { useState } from 'react';
import type {
  ExperimentalSettings,
  HttpFetchMode,
  WebSearchApiProvider,
  WebSearchMode,
} from '@/lib/types';
import Button from '@/components/ui/Button';
import Toggle from '@/components/ui/Toggle';
import Select from '@/components/ui/Select';
import { Card, SettingItem } from './helpers';
import { useSettingsActions } from './SettingsActionsContext';
import { useSettingsStore } from '@/stores/settingsStore';
import * as tauri from '@/lib/tauri';

const DEFAULT_EXPERIMENTAL: ExperimentalSettings = {
  enableWebSearch: true,
  enableHttpFetch: true,
  enableCloudPage: false,
  webSearchMode: 'browser',
  webSearchApiProvider: 'brave',
  httpFetchMode: 'browser',
};

export function ToolCapabilitiesSection() {
  const { settings, update } = useSettingsActions();
  const hasWebSearchApiKey = useSettingsStore((s) => s.hasWebSearchApiKey);
  const [searchKeyDraft, setSearchKeyDraft] = useState('');

  const experimental: ExperimentalSettings = {
    ...DEFAULT_EXPERIMENTAL,
    ...(settings.experimentalSettings ?? {}),
  };

  const updateExperimental = (patch: Partial<ExperimentalSettings>) => {
    update({ experimentalSettings: { ...experimental, ...patch } });
  };

  const searchMode = experimental.webSearchMode ?? 'browser';
  const apiProvider = experimental.webSearchApiProvider ?? 'brave';
  const httpFetchMode = experimental.httpFetchMode ?? 'browser';

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
            description="本机浏览器效果最好；搜索 API 需自备 Key；裸抓零配置但质量一般"
            sectionId="settings-experimental"
            keywords={['web', 'search', 'browser', 'api', 'bing', '搜索方式', '浏览器']}
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

          {searchMode === 'api' && (
            <>
              <SettingItem
                id="exp-websearch-api-provider"
                label="搜索 API 提供商"
                description="独立搜索引擎 HTTP API（非 OpenAI 格式）"
                sectionId="settings-experimental"
                keywords={['brave', 'tavily', 'serpapi', '搜索 API']}
              >
                <Select
                  value={apiProvider}
                  onChange={(v) => updateExperimental({ webSearchApiProvider: v as WebSearchApiProvider })}
                  options={[
                    { value: 'brave', label: 'Brave Search' },
                    { value: 'tavily', label: 'Tavily' },
                  ]}
                  className="w-52"
                />
              </SettingItem>
              <SettingItem
                id="exp-websearch-api-key"
                label="搜索 API Key"
                description="保存在系统密钥链，不会写入配置文件"
                sectionId="settings-experimental"
                keywords={['key', '密钥', 'brave', 'tavily']}
              >
                <div className="flex-1 flex gap-2 items-center">
                  <input
                    type="password"
                    value={searchKeyDraft || (hasWebSearchApiKey ? '********' : '')}
                    onChange={(e) => setSearchKeyDraft(e.target.value)}
                    onBlur={() => {
                      void persistSearchKey(searchKeyDraft);
                    }}
                    placeholder={hasWebSearchApiKey ? '已保存，输入新 Key 可覆盖' : '输入搜索 API Key'}
                    autoComplete="off"
                    className="flex-1 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500"
                  />
                  {hasWebSearchApiKey && (
                    <Button variant="secondary" size="sm" onClick={() => void clearSearchKey()}>
                      清除
                    </Button>
                  )}
                </div>
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
        <SettingItem
          id="exp-httpfetch-mode"
          label="获取方式"
          description="本机浏览器渲染 DOM（推荐）；裸 HTTP 更快但易被站点拦截"
          sectionId="settings-experimental"
          keywords={['http', 'fetch', 'browser', 'html', '网页获取', '浏览器']}
        >
          <Select
            value={httpFetchMode}
            onChange={(v) => updateExperimental({ httpFetchMode: v as HttpFetchMode })}
            options={[
              { value: 'browser', label: '本机浏览器（推荐）' },
              { value: 'html', label: '裸 HTTP GET' },
            ]}
            className="w-52"
          />
        </SettingItem>
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
        id="exp-notification"
        label="通知测试"
        description="测试系统通知功能是否正常"
        sectionId="settings-experimental"
        keywords={['notification', '通知']}
      >
        <Button
          variant="secondary"
          size="sm"
          onClick={async () => {
            try {
              const { sendNotification, isPermissionGranted, requestPermission } = await import(
                '@tauri-apps/plugin-notification'
              );
              let granted = await isPermissionGranted();
              if (!granted) {
                const permission = await requestPermission();
                granted = permission === 'granted';
              }
              if (granted) {
                sendNotification({
                  title: 'Marcel SSH 测试通知',
                  body: '这是一条测试消息，通知功能正常工作！',
                });
              }
            } catch (err) {
              console.error('发送通知失败:', err);
            }
          }}
        >
          发送测试通知
        </Button>
      </SettingItem>
    </Card>
  );
}
