import { useState, useEffect, useRef, useCallback } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import type {
  AppSettings,
  AgentModeSettings,
  LlmConfig,
} from '@/lib/types';
import Button from '@/components/ui/Button';
import { Section, Field } from './helpers';
export { Section, Field } from './helpers';
import { ColorThemeSelector } from './ColorThemeSelector';
import { FontSizeInput } from './FontSizeInput';
import { CommandPolicySection } from './CommandPolicySection';
import { LlmSection } from './LlmSection';
import { ExperimentalSection } from './ExperimentalSection';
import AboutSection from './AboutSection';

interface SectionNavItem {
  id: string;
  label: string;
}

const SECTION_ITEMS: SectionNavItem[] = [
  { id: 'settings-appearance', label: '外观' },
  { id: 'settings-llm', label: 'LLM 配置' },
  { id: 'settings-command-policy', label: '命令策略' },
  { id: 'settings-experimental', label: '实验性功能' },
  { id: 'settings-about', label: '关于' },
];

export default function Settings() {
  const settings = useSettingsStore((s) => s.settings);
  const loaded = useSettingsStore((s) => s.loaded);
  const save = useSettingsStore((s) => s.save);
  const setPreview = useSettingsStore((s) => s.setPreview);
  const clearPreview = useSettingsStore((s) => s.clearPreview);

  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const hasStoredApiKey = useSettingsStore((s) => s.hasApiKey);
  const [activeSection, setActiveSection] = useState<string>('settings-appearance');
  const sectionsContainerRef = useRef<HTMLDivElement>(null);
  const isScrollingRef = useRef(false);

  useEffect(() => {
    const container = sectionsContainerRef.current;
    if (!container) return;

    const updateActiveSection = () => {
      if (isScrollingRef.current) return;
      const containerRect = container.getBoundingClientRect();
      const containerTop = containerRect.top + 80;

      let currentId = SECTION_ITEMS[0].id;
      for (const item of SECTION_ITEMS) {
        const el = document.getElementById(item.id);
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect.top <= containerTop) {
            currentId = item.id;
          }
        }
      }
      if (currentId !== activeSection) {
        setActiveSection(currentId);
      }
    };

    container.addEventListener('scroll', updateActiveSection, { passive: true });
    updateActiveSection();

    return () => container.removeEventListener('scroll', updateActiveSection);
  }, [activeSection]);

  const scrollToSection = useCallback((id: string) => {
    setActiveSection(id);
    isScrollingRef.current = true;
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    setTimeout(() => {
      isScrollingRef.current = false;
    }, 500);
  }, []);

  const [draft, setDraft] = useState<AppSettings | null>(null);

  useEffect(() => {
    if (loaded && draft === null) {
      setDraft(settings);
    }
  }, [loaded, draft, settings]);

  if (!loaded || !draft) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-400">
        加载设置中...
      </div>
    );
  }

  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(settings);

  const updateDraft = (mutator: (s: AppSettings) => AppSettings) => {
    setDraft((cur) => (cur ? mutator(cur) : cur));
  };

  const updateAgent = (mutator: (a: AgentModeSettings) => AgentModeSettings) => {
    updateDraft((s) => ({
      ...s,
      agentModeSettings: mutator(s.agentModeSettings),
    }));
  };

  const updateLlm = (mutator: (l: LlmConfig) => LlmConfig) => {
    updateDraft((s) => ({
      ...s,
      llmConfig: s.llmConfig
        ? mutator(s.llmConfig)
        : mutator({
            providerType: 'openai',
            apiKey: '',
            model: '',
            baseUrl: '',
            temperature: 0.1,
            allowInvalidCerts: false,
          }),
    }));
  };

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    setSavedNotice(null);
    try {
      await save(draft);
      setSavedNotice('设置已保存');
      setTimeout(() => setSavedNotice(null), 2000);
    } catch (err) {
      setSavedNotice(`保存失败：${String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setDraft(settings);
    clearPreview();
  };

  const experimentalSettings = draft.experimentalSettings ?? { enableWebSearch: true, enableHttpFetch: true, enableCloudPage: false };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Page header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-900/50">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-bold text-zinc-100">设置</h1>
          {dirty && (
            <span className="text-xs text-amber-400">有未保存的更改</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {savedNotice && (
            <span className="text-sm text-emerald-400">{savedNotice}</span>
          )}
          {dirty && (
            <Button variant="ghost" onClick={handleReset} disabled={saving}>
              撤销
            </Button>
          )}
          <Button
            variant="primary"
            onClick={handleSave}
            loading={saving}
            disabled={!dirty}
          >
            保存
          </Button>
        </div>
      </div>

      {/* Section navigation bar */}
      <nav className="flex items-center gap-1 px-6 py-2 border-b border-zinc-800 bg-zinc-900/50 overflow-x-auto">
        {SECTION_ITEMS.map((item) => (
          <button
            key={item.id}
            onClick={() => scrollToSection(item.id)}
            className={`
              px-3 py-1.5 rounded-lg text-sm whitespace-nowrap transition-colors
              ${
                activeSection === item.id
                  ? 'bg-zinc-800 text-indigo-400 font-medium'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60'
              }
            `}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto" ref={sectionsContainerRef}>
        <div className="px-6 py-6">
          {/* Section: Appearance */}
          <Section id="settings-appearance" title="外观">
            <Field label="终端颜色">
              <ColorThemeSelector
                value={draft.terminalColors}
                onChange={(terminalColors) => {
                  updateDraft((s) => ({ ...s, terminalColors }));
                  setPreview({ terminalColors });
                }}
              />
            </Field>
            <Field label="字号">
              <FontSizeInput
                value={draft.fontSize}
                onChange={(fontSize) => {
                  updateDraft((s) => ({ ...s, fontSize }));
                  setPreview({ fontSize });
                }}
              />
            </Field>
            <Field label="字体">
              <input
                type="text"
                value={draft.fontFamily}
                onChange={(e) => {
                  const fontFamily = e.target.value;
                  updateDraft((s) => ({ ...s, fontFamily }));
                  setPreview({ fontFamily });
                }}
                className="flex-1 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
              />
            </Field>
          </Section>

          <LlmSection
            llmConfig={draft.llmConfig}
            updateLlm={updateLlm}
            hasStoredApiKey={hasStoredApiKey}
          />

          <CommandPolicySection
            agent={draft.agentModeSettings}
            updateAgent={updateAgent}
          />

          <ExperimentalSection
            experimentalSettings={experimentalSettings}
            updateDraft={updateDraft}
          />

          <AboutSection />
        </div>
      </div>
    </div>
  );
}
