import {
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
} from "@/lib/terminalFont";
import { useSettingsActions } from "@/components/settings/SettingsActionsContext";
import { useLiveSettingsPatch } from "@/components/settings/useLiveSettingsPatch";
import Toggle from "@/components/ui/Toggle";
import { MobileSettingRow } from "./MobileSettingRow";
import { UiThemeEditor } from "@/components/settings/UiThemeEditor";
import { FontFamilyPicker } from "@/components/settings/FontFamilyPicker";

/** Touch-first terminal appearance settings for the mobile shell. */
export function MobileAppearanceSection() {
  const { settings, update } = useSettingsActions();
  // 主题与终端外观走免保存通道：preview 即时生效、停稳后自动落库（与桌面同一实现）。
  const {
    settings: liveSettings,
    preview,
    liveUpdate,
  } = useLiveSettingsPatch();
  const colors = preview?.terminalColors ?? liveSettings.terminalColors;
  const uiTheme = preview?.uiTheme ?? liveSettings.uiTheme;

  const applyFontSize = (fontSize: number) => {
    liveUpdate({ fontSize });
  };

  return (
    <div className="flex flex-col gap-2">
      {/* 应用主题（与桌面共用编辑器与分区模型，lib/uiTheme.ts） */}
      <MobileSettingRow
        label="应用主题"
        description="选预设整体换色（终端配色随主题成套切换），或逐分区自定义；改动即时生效"
      >
        <div className="pt-1">
          <UiThemeEditor
            value={uiTheme}
            terminalColors={colors}
            // 主题与终端配色同一次 patch 写入，与桌面一致
            onChange={(nextTheme, nextColors) =>
              liveUpdate({
                uiTheme: nextTheme,
                ...(nextColors && { terminalColors: nextColors }),
              })
            }
          />
        </div>
      </MobileSettingRow>

      {/* Font size */}
      <MobileSettingRow
        label="终端字号"
        description="只影响终端，不影响界面文字和代码编辑器"
        trailing={
          <span className="w-12 text-right font-mono text-body text-indigo-300">
            {settings.fontSize}px
          </span>
        }
      >
        <input
          type="range"
          min={TERMINAL_FONT_SIZE_MIN}
          max={TERMINAL_FONT_SIZE_MAX}
          value={settings.fontSize}
          onChange={(e) => applyFontSize(parseInt(e.target.value, 10))}
          className="mt-1 h-2 w-full cursor-pointer appearance-none rounded-full bg-zinc-700 accent-indigo-500"
        />
      </MobileSettingRow>

      {/* Font family */}
      <MobileSettingRow
        label="终端字体"
        description="只影响终端；Nerd Fonts 图标已内置"
      >
        <FontFamilyPicker
          variant="mobile"
          value={preview?.fontFamily ?? liveSettings.fontFamily}
          fontSize={preview?.fontSize ?? liveSettings.fontSize}
          terminalColors={colors}
          onChange={(fontFamily) => liveUpdate({ fontFamily })}
        />
      </MobileSettingRow>

      {/* 对话显示（原 display 分区，合并到外观以减少分区数量） */}
      <div className="mt-2 mb-1 px-1 text-meta font-medium text-fg-tertiary">
        对话显示
      </div>
      <MobileSettingRow
        label="隐藏模型思考"
        description="不显示模型的推理/思考内容"
        trailing={
          <Toggle
            checked={settings.hideThinkingDisplay}
            onChange={(checked) => update({ hideThinkingDisplay: checked })}
          />
        }
      />
      <MobileSettingRow
        label="折叠已完成回合"
        description="收起已完成长回合的中间消息和工具调用，保留提问与最终答复；工具卡片分组不受此开关影响"
        trailing={
          <Toggle
            checked={settings.foldCompletedTurns ?? true}
            onChange={(checked) => update({ foldCompletedTurns: checked })}
          />
        }
      />
      <MobileSettingRow
        label="显示玛瑟尔"
        description="Agent 页里的像素小人：干活时按遥控器、等你确认时举手、做完了跳起来；关掉后只保留文字状态"
        trailing={
          <Toggle
            checked={settings.showMascot ?? true}
            onChange={(checked) => update({ showMascot: checked })}
          />
        }
      />
      <MobileSettingRow
        label="隐私模式"
        description="开启后所有界面隐藏 IP 地址和端口（连接功能不受影响）"
        trailing={
          <Toggle
            checked={settings.privacyMode ?? false}
            onChange={(checked) => update({ privacyMode: checked })}
          />
        }
      />
    </div>
  );
}
