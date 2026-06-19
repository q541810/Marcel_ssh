import { useCallback, useEffect, useMemo, useState } from 'react';
import Toggle from '@/components/ui/Toggle';
import { DEFAULT_WHIP_PHRASES, normalizeWhipPhrases } from '@/lib/whip';
import { Card, SettingItem } from './helpers';
import { useSettingsActions } from './SettingsActionsContext';

export function validateWhipPhrases(value: string): string | null {
  const lines = value.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return '至少需要一条文案';
  if (lines.length > 20) return '最多允许 20 条文案';

  for (const line of lines) {
    if (line.length > 80) return `文案过长: "${line.slice(0, 20)}..."（最多 80 字）`;
  }
  return null;
}

export function WhipSection() {
  const { settings, update } = useSettingsActions();
  const crackSpeed = settings.whipCrackSpeed ?? 240;
  const phrasesText = useMemo(
    () => normalizeWhipPhrases(settings.whipPhrases).join('\n'),
    [settings.whipPhrases]
  );
  const [phrasesDraft, setPhrasesDraft] = useState(phrasesText);
  const [phrasesError, setPhrasesError] = useState<string | null>(null);

  useEffect(() => {
    if (!phrasesError) setPhrasesDraft(phrasesText);
  }, [phrasesError, phrasesText]);

  const updateCrackSpeed = (value: number) => {
    const next = Math.min(420, Math.max(120, Math.round(value)));
    update({ whipCrackSpeed: next });
  };

  const handlePhrasesChange = useCallback((value: string) => {
    setPhrasesDraft(value);
    const err = validateWhipPhrases(value);
    setPhrasesError(err);
    if (!err) {
      update({ whipPhrases: value.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 20) });
    }
  }, [update]);

  const handlePhrasesBlur = useCallback(() => {
    setPhrasesError(validateWhipPhrases(phrasesDraft));
  }, [phrasesDraft]);

  const resetPhrases = () => {
    const next = DEFAULT_WHIP_PHRASES.join('\n');
    setPhrasesDraft(next);
    setPhrasesError(null);
    update({ whipPhrases: DEFAULT_WHIP_PHRASES });
  };

  return (
    <Card id="settings-whip" title="鞭子" description="在 Agent 输入框旁启用鞭子按钮，甩响后在屏幕上弹出催促浮字">
      <SettingItem
        id="enable-whip"
        label="打开鞭子"
        description="开启后可在 Agent 输入区生成鞭子；甩动出声时播放音效，可在屏幕上弹出催促浮字，不会改写输入框或打断任务"
        sectionId="settings-whip"
        keywords={['whip', '鞭子', '催促', '音效', '界面']}
      >
        <Toggle
          checked={settings.whipEnabled}
          onChange={(checked) => update({ whipEnabled: checked })}
          label="启用 Agent 鞭子按钮"
        />
      </SettingItem>
      <SettingItem
        id="whip-crack-speed"
        label="甩响阈值"
        description="数值越低越容易甩出声音和催促文案"
        sectionId="settings-whip"
        keywords={['whip', '鞭子', '阈值', '灵敏度', '音效']}
      >
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={120}
            max={420}
            step={10}
            value={crackSpeed}
            onChange={(e) => updateCrackSpeed(Number(e.target.value))}
            className="w-24 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
          />
          <button
            type="button"
            onClick={() => updateCrackSpeed(180)}
            className="px-2.5 py-1.5 rounded-lg text-xs text-zinc-300 bg-zinc-800 hover:bg-zinc-700 transition-colors"
          >
            灵敏
          </button>
          <button
            type="button"
            onClick={() => updateCrackSpeed(240)}
            className="px-2.5 py-1.5 rounded-lg text-xs text-zinc-300 bg-zinc-800 hover:bg-zinc-700 transition-colors"
          >
            默认
          </button>
          <button
            type="button"
            onClick={() => updateCrackSpeed(320)}
            className="px-2.5 py-1.5 rounded-lg text-xs text-zinc-300 bg-zinc-800 hover:bg-zinc-700 transition-colors"
          >
            稳重
          </button>
        </div>
      </SettingItem>
      <SettingItem
        id="whip-floating-text"
        label="鞭响浮字"
        description="关闭后只播放鞭响，不在屏幕上显示催促文案"
        sectionId="settings-whip"
        keywords={['whip', '鞭子', '浮字', '文字', '催促']}
      >
        <Toggle
          checked={settings.whipAutoInputEnabled ?? true}
          onChange={(checked) => update({ whipAutoInputEnabled: checked })}
          label="鞭响时显示浮字"
        />
      </SettingItem>
      <SettingItem
        id="whip-phrases"
        label="催促文案"
        description="一行一句；鞭响时随机选择其中一条显示在屏幕上"
        sectionId="settings-whip"
        keywords={['whip', '鞭子', '文案', '辱骂', '催促']}
      >
        <div className="flex flex-col gap-2">
          <textarea
            value={phrasesDraft}
            onChange={(e) => handlePhrasesChange(e.target.value)}
            onBlur={handlePhrasesBlur}
            rows={5}
            className={`w-full rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500 resize-y min-h-28 ${
              phrasesError
                ? 'bg-red-900/20 border border-red-500/50 focus:border-red-400'
                : 'bg-zinc-800 border border-zinc-700'
            }`}
          />
          {phrasesError && <p className="text-xs text-red-400">{phrasesError}</p>}
          <button
            type="button"
            onClick={resetPhrases}
            className="self-start px-2.5 py-1.5 rounded-lg text-xs text-zinc-300 bg-zinc-800 hover:bg-zinc-700 transition-colors"
          >
            恢复默认文案
          </button>
        </div>
      </SettingItem>
    </Card>
  );
}
