import type { ExperimentalSettings } from '@/lib/types';
import Button from '@/components/ui/Button';
import Toggle from '@/components/ui/Toggle';
import { Card, SettingItem } from './helpers';
import { useSettingsActions } from './SettingsActionsContext';

export function ExperimentalSection() {
  const { settings, update } = useSettingsActions();

  const experimental = settings.experimentalSettings ?? { enableWebSearch: true, enableHttpFetch: true, enableCloudPage: false };

  const updateExperimental = (patch: Partial<ExperimentalSettings>) => {
    update({ experimentalSettings: { ...experimental, ...patch } });
  };

  return (
    <Card id="settings-experimental" title="实验性功能" description="这些功能正在开发中，可能在未来版本中更改或移除">
      <SettingItem id="exp-websearch" label="联网搜索" description="允许 Agent 使用 web_search 工具搜索互联网" sectionId="settings-experimental" keywords={['web', 'search', '搜索']}>
        <Toggle
          checked={experimental.enableWebSearch}
          onChange={(checked) => updateExperimental({ enableWebSearch: checked })}
          label="启用联网搜索"
        />
      </SettingItem>
      <SettingItem id="exp-httpfetch" label="网页获取" description="允许 Agent 使用 http_get 工具获取网页内容" sectionId="settings-experimental" keywords={['http', 'fetch', '网页']}>
        <Toggle
          checked={experimental.enableHttpFetch}
          onChange={(checked) => updateExperimental({ enableHttpFetch: checked })}
          label="启用网页获取"
        />
      </SettingItem>
      <SettingItem id="exp-cloudpage" label="云原神" description="允许 Agent 打开云原神页面" sectionId="settings-experimental" keywords={['cloud', 'genshin', '云原神']}>
        <Toggle
          checked={experimental.enableCloudPage}
          onChange={(checked) => updateExperimental({ enableCloudPage: checked })}
          label="启用云原神"
        />
      </SettingItem>
      <SettingItem id="exp-notification" label="通知测试" description="测试系统通知功能是否正常" sectionId="settings-experimental" keywords={['notification', '通知']}>
        <Button
          variant="secondary"
          size="sm"
          onClick={async () => {
            try {
              const { sendNotification, isPermissionGranted, requestPermission } = await import('@tauri-apps/plugin-notification');
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
