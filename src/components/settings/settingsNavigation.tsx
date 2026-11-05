import type React from 'react';
import { Bell, Bookmark, Bot, Cloud, Cpu, Info, Monitor, Wrench } from 'lucide-react';
import {
  SETTINGS_PAGES,
  type SettingsGroupId,
  type SettingsPage,
  type SettingsPageId,
} from '@/lib/settingsCatalog';

export interface SettingsCategory extends SettingsPage {
  icon: React.ReactNode;
  /** 这一页里挂哪些分区（桌面端的组合；页名、分组、顺序来自 `lib/settingsCatalog`）。 */
  sections: string[];
  /** 组 id，侧栏据此画组标题。 */
  group: SettingsGroupId;
}

export type SettingsSectionSpan = 'half' | 'full';

export const SETTINGS_SECTION_SPAN: Record<string, SettingsSectionSpan> = {
  'settings-theme': 'half',
  'settings-layout': 'half',
  'settings-display': 'half',
  'settings-llm': 'full',
  'settings-command-policy': 'full',
  'settings-agent-system-prompt': 'full',
  'settings-agent-limits': 'full',
  'settings-notification': 'half',
  'settings-conversations': 'half',
  'settings-memory': 'full',
  // 作用域目录 + 列表 + 整理助手，窄了列表就挤成一条缝
  'settings-memory-manage': 'full',
  'settings-experimental': 'half',
  // 含 JSON 配置片段，需要整行宽度才不会被折断成看不懂的样子
  'settings-mcp-server': 'full',
  'settings-transfer': 'half',
  // 状态 / 设备列表 / 同步记录都是整行内容，半宽会把记录挤成一条缝
  'settings-sync': 'full',
  'settings-about': 'half',
  'settings-plugins': 'full',
};

/** 桌面端每一页的图标与分区组合；页本身的定义（名字 / 分组 / 顺序）在 `lib/settingsCatalog`。 */
const DESKTOP_PAGE_LAYOUT: Record<SettingsPageId, { icon: React.ReactNode; sections: string[] }> = {
  model: {
    icon: <Cpu className="w-4 h-4" />,
    sections: ['settings-llm'],
  },
  // 先讲「它会不会乱来」（安全与审批），再讲附加指令，最后是执行上限
  agent: {
    icon: <Bot className="w-4 h-4" />,
    sections: ['settings-command-policy', 'settings-agent-system-prompt', 'settings-agent-limits'],
  },
  memory: {
    icon: <Bookmark className="w-4 h-4" />,
    sections: ['settings-memory', 'settings-memory-manage'],
  },
  tools: {
    icon: <Wrench className="w-4 h-4" />,
    sections: ['settings-experimental', 'settings-mcp-server', 'settings-plugins'],
  },
  appearance: {
    icon: <Monitor className="w-4 h-4" />,
    sections: ['settings-theme', 'settings-layout', 'settings-display', 'settings-transfer'],
  },
  notification: {
    icon: <Bell className="w-4 h-4" />,
    sections: ['settings-notification'],
  },
  sync: {
    icon: <Cloud className="w-4 h-4" />,
    sections: ['settings-sync', 'settings-conversations'],
  },
  about: {
    icon: <Info className="w-4 h-4" />,
    sections: ['settings-about'],
  },
};

export const SETTINGS_CATEGORIES: SettingsCategory[] = SETTINGS_PAGES.map((page) => ({
  ...page,
  ...DESKTOP_PAGE_LAYOUT[page.id],
}));

/**
 * `分类 id → section id 列表` 的查表形式。
 *
 * **从 `SETTINGS_CATEGORIES` 派生**，不再手写第二份：两份列表一旦漂移，
 * 症状是「某个 section 在分类里能看到、搜索却搜不到」（或反过来），
 * 而且加 section 时很容易只改一处。派生之后新增 section 只有一个地方要动。
 */
export const SETTINGS_CATEGORY_SECTIONS: Record<string, string[]> = Object.fromEntries(
  SETTINGS_CATEGORIES.map((category) => [category.id, category.sections]),
);

export function getSettingsCategoryLabel(id: string) {
  return SETTINGS_CATEGORIES.find((category) => category.id === id)?.title ?? '设置';
}
