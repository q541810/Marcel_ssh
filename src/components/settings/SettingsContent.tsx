import { useLayoutEffect, useMemo, useRef } from 'react';
import { useSearchRegistry } from './helpers';
import { ChevronLeft } from 'lucide-react';
import { AgentLimitsSection, AgentPolicySection } from './AgentPolicySection';
import { RiskRulesPage } from './RiskRulesPage';
import { useRiskRuleFocusStore } from '@/stores/riskRuleFocusStore';
import { useMarketPageStore } from '@/stores/marketPageStore';
import { AgentSystemPromptSection } from './AgentSystemPromptSection';
import AboutSection from './AboutSection';
import { ConversationDisplaySection } from './ConversationDisplaySection';
import { ConversationArchiveSection } from './ConversationArchiveSection';
import { ModelServiceSection } from './ModelServiceSection';
import { NotificationSection } from './NotificationSection';
import { MemoryManageSection, MemorySection } from './MemorySection';
import { ThemeSection } from './ThemeSection';
import { WorkspaceLayoutSection } from './WorkspaceLayoutSection';
import { ToolCapabilitiesSection } from './ToolCapabilitiesSection';
import { TransferSection } from './TransferSection';
import { SyncSection } from './SyncSection';
import { McpServerSection } from './McpServerSection';
import { PluginSection } from './PluginSection';
import { MarketSection } from '@/components/market/MarketSection';
import {
  getSettingsCategoryLabel,
  SETTINGS_CATEGORIES,
  SETTINGS_CATEGORY_SECTIONS,
  SETTINGS_SECTION_SPAN,
} from './settingsNavigation';
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

    // 搜页名 / 旧页名（如「工具能力」「会话与归档」）→ 直接列出那一页的全部分区，
    // 改名后老用户按旧名搜仍然能找到。
    for (const category of SETTINGS_CATEGORIES) {
      const names = [category.title, ...category.aliases].map((n) => n.toLowerCase());
      if (names.some((n) => n.includes(query))) {
        for (const id of category.sections) matching.add(id);
      }
    }

    return Array.from(matching);
  }, [activeCategory, searchQuery, items]);

  const isSearching = searchQuery.trim().length > 0;

  // 「内置风险规则」二级页：挂在 Agent 分类里，打开时替换整个分类内容（搜索时不进，
  // 搜索结果里的"内置风险规则"入口行点了才进）。进去回到顶部，返回时回到离开前的位置。
  const rulesPageOpen = useRiskRuleFocusStore((s) => s.pageOpen);
  const showRulesPage = rulesPageOpen && activeCategory === 'agent' && !isSearching;
  const scrollRef = useRef<HTMLDivElement>(null);
  const mainScrollTop = useRef(0);
  const wasRulesPage = useRef(false);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || wasRulesPage.current === showRulesPage) return;
    if (showRulesPage) {
      el.scrollTop = 0;
    } else {
      el.scrollTop = mainScrollTop.current;
    }
    wasRulesPage.current = showRulesPage;
  }, [showRulesPage]);

  // 插件市场二级页：挂在「工具与扩展」下面（入口在「插件」卡片里）。市场是浏览型界面，
  // 不走设置项的 section grid 框架，全宽渲染；搜索时不进，换分类即退出。
  const marketOpen = useMarketPageStore((s) => s.open);
  const closeMarketPage = useMarketPageStore((s) => s.closePage);
  if (marketOpen && activeCategory === 'tools' && !isSearching) {
    return (
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-surface">
        <div className="flex-shrink-0 border-b border-edge-subtle px-4 py-2">
          <button
            type="button"
            onClick={closeMarketPage}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-body text-fg-secondary transition-colors hover:bg-state-soft/60 hover:text-fg"
          >
            <ChevronLeft className="h-4 w-4" />
            返回{getSettingsCategoryLabel('tools')}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <MarketSection />
        </div>
      </div>
    );
  }

  const allSections = [
    { id: 'settings-theme', element: <ThemeSection /> },
    { id: 'settings-layout', element: <WorkspaceLayoutSection /> },
    { id: 'settings-display', element: <ConversationDisplaySection /> },
    { id: 'settings-llm', element: <ModelServiceSection /> },
    { id: 'settings-command-policy', element: <AgentPolicySection /> },
    { id: 'settings-agent-system-prompt', element: <AgentSystemPromptSection /> },
    { id: 'settings-agent-limits', element: <AgentLimitsSection /> },
    { id: 'settings-notification', element: <NotificationSection /> },
    { id: 'settings-conversations', element: <ConversationArchiveSection /> },
    { id: 'settings-memory', element: <MemorySection /> },
    { id: 'settings-memory-manage', element: <MemoryManageSection /> },
    { id: 'settings-experimental', element: <ToolCapabilitiesSection /> },
    { id: 'settings-mcp-server', element: <McpServerSection /> },
    { id: 'settings-transfer', element: <TransferSection /> },
    { id: 'settings-sync', element: <SyncSection /> },
    { id: 'settings-about', element: <AboutSection /> },
    { id: 'settings-plugins', element: <PluginSection /> },
  ];
  // 搜索时渲染全部 Section（隐藏不匹配的），确保所有 SettingItem 注册到搜索索引；
  // 非搜索时只渲染当前分类，零额外开销。
  const sections = isSearching
    ? allSections
    : allSections.filter((section) => visibleSections.includes(section.id));

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => {
        if (!showRulesPage) mainScrollTop.current = e.currentTarget.scrollTop;
      }}
      className="flex-1 overflow-y-auto bg-surface"
    >
      <div
        className="settings-layout-frame mx-auto py-8"
        style={{
          maxWidth: `${layout.contentMaxWidth}px`,
          paddingLeft: `${layout.contentPaddingX}px`,
          paddingRight: `${layout.contentPaddingX}px`,
        }}
      >
        {showRulesPage ? (
          <RiskRulesPage />
        ) : (
          <>
            <h1 className="text-headline text-fg mb-6">
              {isSearching ? `搜索：${searchQuery}` : getSettingsCategoryLabel(activeCategory)}
            </h1>

            {visibleSections.length === 0 && isSearching && (
              <div className="text-fg-tertiary text-center py-12">未找到匹配的设置项</div>
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
          </>
        )}
      </div>
    </div>
  );
}
