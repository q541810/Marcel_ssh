import type React from 'react';
import { Bot, Cpu, Info, Monitor, Plug, Store, UploadCloud, Wrench } from 'lucide-react';

export interface SettingsCategory {
  id: string;
  label: string;
  icon: React.ReactNode;
  sections: string[];
}

export type SettingsSectionSpan = 'half' | 'full';

export const SETTINGS_SECTION_SPAN: Record<string, SettingsSectionSpan> = {
  'settings-appearance': 'half',
  'settings-display': 'half',
  'settings-llm': 'full',
  'settings-command-policy': 'full',
  'settings-agent-system-prompt': 'full',
  'settings-notification': 'half',
  'settings-experimental': 'half',
  // 含 JSON 配置片段，需要整行宽度才不会被折断成看不懂的样子
  'settings-mcp-server': 'full',
  'settings-transfer': 'half',
  'settings-about': 'half',
  'settings-plugins': 'full',
  'settings-market': 'full',
};

export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  {
    id: 'interface',
    label: '界面',
    icon: <Monitor className="w-4 h-4" />,
    sections: ['settings-appearance', 'settings-display'],
  },
  {
    id: 'model',
    label: '模型',
    icon: <Cpu className="w-4 h-4" />,
    sections: ['settings-llm'],
  },
  {
    id: 'agent',
    label: 'Agent',
    icon: <Bot className="w-4 h-4" />,
    sections: [
      'settings-command-policy',
      'settings-agent-system-prompt',
      'settings-notification',
    ],
  },
  {
    id: 'tools',
    label: '工具能力',
    icon: <Wrench className="w-4 h-4" />,
    sections: ['settings-experimental', 'settings-mcp-server'],
  },
  {
    id: 'transfer',
    label: '文件传输',
    icon: <UploadCloud className="w-4 h-4" />,
    sections: ['settings-transfer'],
  },
  {
    id: 'plugins',
    label: '插件',
    icon: <Plug className="w-4 h-4" />,
    sections: ['settings-plugins'],
  },
  {
    id: 'market',
    label: '插件市场',
    icon: <Store className="w-4 h-4" />,
    sections: ['settings-market'],
  },
  {
    id: 'about',
    label: '关于',
    icon: <Info className="w-4 h-4" />,
    sections: ['settings-about'],
  },
];

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
  return SETTINGS_CATEGORIES.find((category) => category.id === id)?.label ?? '设置';
}
