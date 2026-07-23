import { useState, useEffect, useMemo } from 'react';
import type { TerminalColors } from '@/lib/types';
import { TERMINAL_COLOR_PRESETS } from '@/lib/constants';

const COLOR_FIELDS: { key: keyof TerminalColors; label: string }[] = [
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

export function ColorThemeSelector({
  value,
  onChange,
}: {
  value: TerminalColors;
  onChange: (colors: TerminalColors) => void;
}) {
  const [showCustom, setShowCustom] = useState(false);
  const [customColors, setCustomColors] = useState<TerminalColors>(value);

  useEffect(() => {
    setCustomColors(value);
  }, [value]);

  const handlePresetSelect = (preset: TerminalColors) => {
    onChange(preset);
    setShowCustom(false);
  };

  const handleCustomChange = (key: keyof TerminalColors, color: string) => {
    const newColors = { ...customColors, [key]: color };
    setCustomColors(newColors);
    onChange(newColors);
  };

  const selectedPresetName = useMemo(() => {
    const valueKey = JSON.stringify(value);
    return TERMINAL_COLOR_PRESETS.find((p) => JSON.stringify(p.colors) === valueKey)?.name;
  }, [value]);

  return (
    <div className="flex-1 space-y-3">
      <div className="flex flex-wrap gap-2">
        {TERMINAL_COLOR_PRESETS.map((preset) => (
          <button
            key={preset.name}
            onClick={() => handlePresetSelect(preset.colors)}
            className={`
              px-3 py-1.5 rounded-lg text-sm transition-all
              ${selectedPresetName === preset.name
                ? 'bg-green-600 text-white ring-2 ring-green-400'
                : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 border border-zinc-700'
              }
            `}
          >
            <span className="flex items-center gap-2">
              <span
                className="w-4 h-4 rounded border border-zinc-600"
                style={{ backgroundColor: preset.colors.background }}
              />
              {preset.name}
            </span>
          </button>
        ))}
        <button
          onClick={() => setShowCustom(!showCustom)}
          className={`
            px-3 py-1.5 rounded-lg text-sm transition-all
            ${showCustom
              ? 'bg-green-600 text-white ring-2 ring-green-400'
              : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 border border-zinc-700'
            }
          `}
        >
          自定义
        </button>
      </div>

      {showCustom && (
        <div className="p-4 bg-zinc-800/50 rounded-xl border border-zinc-700 space-y-3">
          <div className="text-xs text-zinc-400 mb-2">点击颜色块选择颜色，或直接输入十六进制颜色值</div>
          <div className="grid grid-cols-4 gap-2">
            {COLOR_FIELDS.map(({ key, label }) => (
              <div key={key} className="flex items-center gap-2">
                <label className="text-xs text-zinc-400 w-12">{label}</label>
                <div className="relative flex-1">
                  <input
                    type="color"
                    value={customColors[key]}
                    onChange={(e) => handleCustomChange(key, e.target.value)}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                  <div
                    className="w-full h-6 rounded border border-zinc-600 cursor-pointer"
                    style={{ backgroundColor: customColors[key] }}
                  />
                </div>
                <input
                  type="text"
                  value={customColors[key]}
                  onChange={(e) => handleCustomChange(key, e.target.value)}
                  className="w-20 px-2 py-1 text-xs bg-zinc-900 border border-zinc-700 rounded text-zinc-300 font-mono"
                  placeholder="#000000"
                />
              </div>
            ))}
          </div>
          <div className="pt-2 border-t border-zinc-700">
            <div className="text-xs text-zinc-500 mb-2">预览</div>
            <div
              className="p-3 rounded-lg font-mono text-sm"
              style={{
                backgroundColor: customColors.background,
                color: customColors.foreground,
              }}
            >
              <div className="flex gap-2 mb-1">
                <span style={{ color: customColors.red }}>错误</span>
                <span style={{ color: customColors.green }}>成功</span>
                <span style={{ color: customColors.yellow }}>警告</span>
                <span style={{ color: customColors.blue }}>信息</span>
              </div>
              <div style={{ color: customColors.cyan }}>user@host:~$</div>
              <div>ls -la</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
