import Toggle from '@/components/ui/Toggle';
import { Card, SettingItem } from './helpers';
import { useSettingsActions } from './SettingsActionsContext';
import type { AppearanceTheme } from '@/lib/types';

const THEME_OPTIONS: { value: AppearanceTheme; label: string }[] = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
];

export function AppearanceSection() {
  const { settings, update, setPreview } = useSettingsActions();
  const appearance = settings.appearance ?? { theme: 'light' as AppearanceTheme, acrylic: true };

  const changeAppearance = (patch: Partial<typeof appearance>) => {
    const next = { ...appearance, ...patch };
    setPreview({ appearance: next });
    update({ appearance: next });
  };

  return (
    <Card
      id="settings-appearance-ui"
      title="外观"
      description="WinUI 风格界面：主题与亚克力背景"
    >
      <SettingItem
        id="ui-theme"
        label="主题"
        description="默认浅色，可切换深色或跟随系统"
        sectionId="settings-appearance-ui"
        keywords={['theme', 'dark', 'light', 'system', '浅色', '深色', '主题', '外观', '皮肤']}
      >
        <div className="flex flex-wrap gap-2">
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => changeAppearance({ theme: opt.value })}
              className={`
                px-3 py-1.5 rounded-lg text-sm transition-all
                ${appearance.theme === opt.value
                  ? 'bg-indigo-600 text-white ring-2 ring-indigo-400'
                  : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 border border-zinc-700'}
              `}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </SettingItem>
      <SettingItem
        id="ui-acrylic"
        label="亚克力效果"
        description="让窗口透出桌面背景（Windows 原生 Acrylic），可在设置中随时关闭"
        sectionId="settings-appearance-ui"
        keywords={['acrylic', 'mica', 'transparent', '亚克力', '透明', '背景', '磨砂', '外观']}
      >
        <Toggle
          checked={appearance.acrylic}
          onChange={(checked) => changeAppearance({ acrylic: checked })}
          label={appearance.acrylic ? '已开启' : '已关闭'}
        />
      </SettingItem>
    </Card>
  );
}
