import type { ExperimentalSettings, AppSettings } from '@/lib/types';
import Button from '@/components/ui/Button';
import Toggle from '@/components/ui/Toggle';
import { Section, Field } from './helpers';

interface ExperimentalSectionProps {
  experimentalSettings: ExperimentalSettings;
  updateDraft: (mutator: (s: AppSettings) => AppSettings) => void;
}

export function ExperimentalSection({ experimentalSettings, updateDraft }: ExperimentalSectionProps) {
  return (
    <Section
      id="settings-experimental"
      title="实验性功能"
      description="这些功能正在开发中，可能在未来版本中更改或移除。"
    >
      <Field label="联网搜索">
        <Toggle
          checked={experimentalSettings.enableWebSearch}
          onChange={(checked) => {
            const current = experimentalSettings;
            updateDraft((s) => ({
              ...s,
              experimentalSettings: { ...current, enableWebSearch: checked },
            }));
          }}
          label="允许 Agent 使用 web_search 工具搜索互联网"
        />
      </Field>
      <Field label="网页获取">
        <Toggle
          checked={experimentalSettings.enableHttpFetch}
          onChange={(checked) => {
            const current = experimentalSettings;
            updateDraft((s) => ({
              ...s,
              experimentalSettings: { ...current, enableHttpFetch: checked },
            }));
          }}
          label="允许 Agent 使用 http_get 工具获取网页内容"
        />
      </Field>
      <Field label="云原神">
        <Toggle
          checked={experimentalSettings.enableCloudPage}
          onChange={(checked) => {
            const current = experimentalSettings;
            updateDraft((s) => ({
              ...s,
              experimentalSettings: { ...current, enableCloudPage: checked },
            }));
          }}
          label="允许 Agent 打开云原神页面"
        />
      </Field>
      <Field label="通知测试">
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
      </Field>
    </Section>
  );
}
