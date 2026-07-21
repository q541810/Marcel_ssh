import { useState } from 'react';
import type { TerminalColors } from '@/lib/types';
import { TERMINAL_COLOR_PRESETS } from '@/lib/constants';
import { useSettingsActions } from '@/components/settings/SettingsActionsContext';
import { MobileSettingRow } from './MobileSettingRow';

const CUSTOM_COLOR_FIELDS: { key: keyof TerminalColors; label: string }[] = [
  { key: 'background', label: '背景' },
  { key: 'foreground', label: '前景' },
  { key: 'cursor', label: '光标' },
  { key: 'selectionBackground', label: '选区' },
  { key: 'black', label: '黑' },
  { key: 'red', label: '红' },
  { key: 'green', label: '绿' },
  { key: 'yellow', label: '黄' },
  { key: 'blue', label: '蓝' },
  { key: 'magenta', label: '品红' },
  { key: 'cyan', label: '青' },
  { key: 'white', label: '白' },
  { key: 'brightBlack', label: '亮黑' },
  { key: 'brightRed', label: '亮红' },
  { key: 'brightGreen', label: '亮绿' },
  { key: 'brightYellow', label: '亮黄' },
  { key: 'brightBlue', label: '亮蓝' },
  { key: 'brightMagenta', label: '亮品红' },
  { key: 'brightCyan', label: '亮青' },
  { key: 'brightWhite', label: '亮白' },
];

/** Touch-first terminal appearance settings for the mobile shell. */
export function MobileAppearanceSection() {
  const { settings, update, setPreview } = useSettingsActions();
  const [customOpen, setCustomOpen] = useState(false);

  const colors = settings.terminalColors;
  const selectedPresetName = TERMINAL_COLOR_PRESETS.find(
    (p) => JSON.stringify(p.colors) === JSON.stringify(colors),
  )?.name;

  const applyColors = (terminalColors: TerminalColors) => {
    setPreview({ terminalColors });
    update({ terminalColors });
  };

  const applyFontSize = (fontSize: number) => {
    setPreview({ fontSize });
    update({ fontSize });
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Color presets */}
      <MobileSettingRow label="终端颜色" description="选择终端配色方案">
        <div className="grid grid-cols-2 gap-2 pt-1">
          {TERMINAL_COLOR_PRESETS.map((preset) => {
            const selected = !customOpen && selectedPresetName === preset.name;
            return (
              <button
                key={preset.name}
                type="button"
                onClick={() => {
                  setCustomOpen(false);
                  applyColors(preset.colors);
                }}
                className={`flex items-center gap-2.5 rounded-xl border px-3 py-3 text-left ${
                  selected
                    ? 'border-indigo-500 bg-indigo-500/10'
                    : 'border-zinc-800 bg-zinc-900 active:bg-zinc-800'
                }`}
              >
                <span
                  className="h-6 w-6 flex-shrink-0 rounded-md border border-zinc-600"
                  style={{ backgroundColor: preset.colors.background }}
                />
                <span
                  className={`truncate text-sm ${
                    selected ? 'font-medium text-indigo-200' : 'text-zinc-300'
                  }`}
                >
                  {preset.name}
                </span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setCustomOpen((v) => !v)}
            className={`flex items-center gap-2.5 rounded-xl border px-3 py-3 text-left ${
              customOpen
                ? 'border-indigo-500 bg-indigo-500/10'
                : 'border-zinc-800 bg-zinc-900 active:bg-zinc-800'
            }`}
          >
            <span className="h-6 w-6 flex-shrink-0 rounded-md border border-zinc-600 bg-gradient-to-br from-red-500 via-green-500 to-blue-500" />
            <span
              className={`text-sm ${customOpen ? 'font-medium text-indigo-200' : 'text-zinc-300'}`}
            >
              自定义
            </span>
          </button>
        </div>

        {customOpen && (
          <div className="mt-2 space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-3">
            <div className="grid grid-cols-2 gap-x-3 gap-y-2">
              {CUSTOM_COLOR_FIELDS.map(({ key, label }) => (
                <label key={key} className="flex items-center gap-2">
                  <span className="w-12 flex-shrink-0 text-xs text-zinc-400">
                    {label}
                  </span>
                  <span className="relative h-8 flex-1">
                    <input
                      type="color"
                      value={colors[key]}
                      onChange={(e) =>
                        applyColors({ ...colors, [key]: e.target.value })
                      }
                      className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                    />
                    <span
                      className="flex h-full items-center justify-center rounded-lg border border-zinc-700 font-mono text-[10px] text-zinc-400"
                      style={{ backgroundColor: colors[key] }}
                    />
                  </span>
                </label>
              ))}
            </div>
            <div
              className="rounded-lg p-3 font-mono text-xs"
              style={{
                backgroundColor: colors.background,
                color: colors.foreground,
              }}
            >
              <div className="mb-1 flex gap-2">
                <span style={{ color: colors.red }}>错误</span>
                <span style={{ color: colors.green }}>成功</span>
                <span style={{ color: colors.yellow }}>警告</span>
                <span style={{ color: colors.blue }}>信息</span>
              </div>
              <div style={{ color: colors.cyan }}>user@host:~$</div>
            </div>
          </div>
        )}
      </MobileSettingRow>

      {/* Font size */}
      <MobileSettingRow
        label="字号"
        description="终端字体大小"
        trailing={
          <span className="w-12 text-right font-mono text-sm text-indigo-300">
            {settings.fontSize}px
          </span>
        }
      >
        <input
          type="range"
          min={10}
          max={32}
          value={settings.fontSize}
          onChange={(e) => applyFontSize(parseInt(e.target.value, 10))}
          className="mt-1 h-2 w-full cursor-pointer appearance-none rounded-full bg-zinc-700 accent-indigo-500"
        />
      </MobileSettingRow>

      {/* Font family */}
      <MobileSettingRow label="字体" description="终端字体族">
        <input
          type="text"
          value={settings.fontFamily}
          onChange={(e) => {
            const fontFamily = e.target.value;
            setPreview({ fontFamily });
            update({ fontFamily });
          }}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 font-mono text-sm text-zinc-100 outline-none focus:border-indigo-500"
        />
      </MobileSettingRow>
    </div>
  );
}
