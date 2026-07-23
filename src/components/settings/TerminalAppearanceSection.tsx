import { Card, SettingItem } from './helpers';
import { useSettingsActions } from './SettingsActionsContext';
import { ColorThemeSelector } from './ColorThemeSelector';
import { FontSizeInput } from './FontSizeInput';

export function TerminalAppearanceSection() {
  const { settings, update, setPreview } = useSettingsActions();

  return (
    <Card id="settings-appearance" title="终端外观" description="调整终端的配色和字体表现">
      <SettingItem
        id="terminal-colors"
        label="终端颜色"
        description="选择终端配色方案"
        sectionId="settings-appearance"
        keywords={['theme', 'color', 'scheme', '配色', '界面', '终端外观']}
      >
        <ColorThemeSelector
          value={settings.terminalColors}
          onChange={(terminalColors) => {
            setPreview({ terminalColors });
            update({ terminalColors });
          }}
        />
      </SettingItem>
      <SettingItem
        id="font-size"
        label="字号"
        description="终端字体大小"
        sectionId="settings-appearance"
        keywords={['font', 'size', '字体大小', '界面', '终端外观']}
      >
        <FontSizeInput
          value={settings.fontSize}
          onChange={(fontSize) => {
            setPreview({ fontSize });
            update({ fontSize });
          }}
        />
      </SettingItem>
      <SettingItem
        id="font-family"
        label="字体"
        description="终端字体族"
        sectionId="settings-appearance"
        keywords={['font', 'family', 'typeface', '字体', '界面', '终端外观']}
      >
        <input
          type="text"
          value={settings.fontFamily}
          onChange={(e) => {
            const fontFamily = e.target.value;
            setPreview({ fontFamily });
            update({ fontFamily });
          }}
          className="flex-1 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-green-500"
        />
      </SettingItem>
    </Card>
  );
}
