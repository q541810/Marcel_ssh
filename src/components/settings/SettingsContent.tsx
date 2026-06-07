import { useMemo } from 'react';
import { useSearchRegistry } from './helpers';
import { AgentPolicySection } from './AgentPolicySection';
import AboutSection from './AboutSection';
import { ConversationDisplaySection } from './ConversationDisplaySection';
import { ModelServiceSection } from './ModelServiceSection';
import { ModelRetrySection } from './ModelRetrySection';
import { NotificationSection } from './NotificationSection';
import { TerminalAppearanceSection } from './TerminalAppearanceSection';
import { ToolCapabilitiesSection } from './ToolCapabilitiesSection';
import { TransferSection } from './TransferSection';
import { getSettingsCategoryLabel, SETTINGS_CATEGORY_SECTIONS } from './settingsNavigation';

interface SettingsContentProps {
  activeCategory: string;
  searchQuery: string;
}

export function SettingsContent({ activeCategory, searchQuery }: SettingsContentProps) {
  const { items } = useSearchRegistry();

  const visibleSections = useMemo(() => {
    if (!searchQuery.trim()) {
      return SETTINGS_CATEGORY_SECTIONS[activeCategory] || [];
    }

    const query = searchQuery.toLowerCase();
    const matching = new Set<string>();

    for (const item of items) {
      const text = `${item.label} ${item.description || ''} ${(item.keywords || []).join(' ')}`.toLowerCase();
      if (text.includes(query)) {
        matching.add(item.sectionId);
      }
    }

    return Array.from(matching);
  }, [activeCategory, searchQuery, items]);

  const isSearching = searchQuery.trim().length > 0;

  return (
    <div className="flex-1 overflow-y-auto bg-zinc-900">
      <div className="max-w-3xl mx-auto px-8 py-8">
        <h1 className="text-2xl font-bold text-zinc-100 mb-6">
          {isSearching ? `搜索：${searchQuery}` : getSettingsCategoryLabel(activeCategory)}
        </h1>

        {visibleSections.length === 0 && isSearching && (
          <div className="text-zinc-500 text-center py-12">未找到匹配的设置项</div>
        )}

        <div hidden={!visibleSections.includes('settings-appearance')}><TerminalAppearanceSection /></div>
        <div hidden={!visibleSections.includes('settings-display')}><ConversationDisplaySection /></div>
        <div hidden={!visibleSections.includes('settings-llm')}><ModelServiceSection /></div>
        <div hidden={!visibleSections.includes('settings-llm-retry')}><ModelRetrySection /></div>
        <div hidden={!visibleSections.includes('settings-command-policy')}><AgentPolicySection /></div>
        <div hidden={!visibleSections.includes('settings-notification')}><NotificationSection /></div>
        <div hidden={!visibleSections.includes('settings-experimental')}><ToolCapabilitiesSection /></div>
        <div hidden={!visibleSections.includes('settings-transfer')}><TransferSection /></div>
        <div hidden={!visibleSections.includes('settings-about')}><AboutSection /></div>
      </div>
    </div>
  );
}
