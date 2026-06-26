import { useMemo } from 'react';
import { useSearchRegistry } from './helpers';
import { AgentPolicySection } from './AgentPolicySection';
import { AgentSystemPromptSection } from './AgentSystemPromptSection';
import AboutSection from './AboutSection';
import { ConversationDisplaySection } from './ConversationDisplaySection';
import { ModelServiceSection } from './ModelServiceSection';
import { ModelRetrySection } from './ModelRetrySection';
import { NotificationSection } from './NotificationSection';
import { TerminalAppearanceSection } from './TerminalAppearanceSection';
import { ToolCapabilitiesSection } from './ToolCapabilitiesSection';
import { TransferSection } from './TransferSection';
import { WhipSection } from './WhipSection';
import { PluginSection } from './PluginSection';
import { getSettingsCategoryLabel, SETTINGS_CATEGORY_SECTIONS, SETTINGS_SECTION_SPAN } from './settingsNavigation';
import { useSettingsLayout } from './helpers';

interface SettingsContentProps {
  activeCategory: string;
  searchQuery: string;
}

export function SettingsContent({ activeCategory, searchQuery }: SettingsContentProps) {
  const { items } = useSearchRegistry();
  const layout = useSettingsLayout();

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
  const allSections = [
    { id: 'settings-appearance', element: <TerminalAppearanceSection /> },
    { id: 'settings-display', element: <ConversationDisplaySection /> },
    { id: 'settings-whip', element: <WhipSection /> },
    { id: 'settings-llm', element: <ModelServiceSection /> },
    { id: 'settings-llm-retry', element: <ModelRetrySection /> },
    { id: 'settings-command-policy', element: <AgentPolicySection /> },
    { id: 'settings-agent-system-prompt', element: <AgentSystemPromptSection /> },
    { id: 'settings-notification', element: <NotificationSection /> },
    { id: 'settings-experimental', element: <ToolCapabilitiesSection /> },
    { id: 'settings-transfer', element: <TransferSection /> },
    { id: 'settings-about', element: <AboutSection /> },
    { id: 'settings-plugins', element: <PluginSection /> },
  ];
  // 搜索时渲染全部 Section（隐藏不匹配的），确保所有 SettingItem 注册到搜索索引；
  // 非搜索时只渲染当前分类，零额外开销。
  const sections = isSearching
    ? allSections
    : allSections.filter((section) => visibleSections.includes(section.id));

  return (
    <div className="flex-1 overflow-y-auto bg-zinc-900">
      <div
        className="settings-layout-frame mx-auto py-8"
        style={{
          maxWidth: `${layout.contentMaxWidth}px`,
          paddingLeft: `${layout.contentPaddingX}px`,
          paddingRight: `${layout.contentPaddingX}px`,
        }}
      >
        <h1 className="text-2xl font-bold text-zinc-100 mb-6">
          {isSearching ? `搜索：${searchQuery}` : getSettingsCategoryLabel(activeCategory)}
        </h1>

        {visibleSections.length === 0 && isSearching && (
          <div className="text-zinc-500 text-center py-12">未找到匹配的设置项</div>
        )}

        <div
          className={`settings-section-grid ${layout.sectionColumns === 2 ? 'grid grid-cols-2 gap-6 items-start' : 'space-y-6'}`}
          data-columns={layout.sectionColumns}
        >
          {sections.map((section) => (
            <div
              key={section.id}
              className={layout.sectionColumns === 2 && SETTINGS_SECTION_SPAN[section.id] === 'full' ? 'col-span-2' : ''}
              style={isSearching && !visibleSections.includes(section.id) ? { display: 'none' } : undefined}
            >
              {section.element}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
