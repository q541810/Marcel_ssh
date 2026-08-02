import type React from 'react';
import { Bot, Cloud, Cpu, Info, Monitor, Plug, Store, UploadCloud, Wrench } from 'lucide-react';

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
  'settings-llm-retry': 'full',
  'settings-command-policy': 'full',
  'settings-agent-system-prompt': 'full',
  'settings-notification': 'half',
  'settings-experimental': 'half',
  'settings-transfer': 'half',
  'settings-about': 'half',
  'settings-plugins': 'full',
  'settings-market': 'full',
  'settings-sync': 'full',
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
    sections: ['settings-llm', 'settings-llm-retry'],
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
    sections: ['settings-experimental'],
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
    id: 'sync',
    label: '同步',
    icon: <Cloud className="w-4 h-4" />,
    sections: ['settings-sync'],
  },
  {
    id: 'about',
    label: '关于',
    icon: <Info className="w-4 h-4" />,
    sections: ['settings-about'],
  },
];

export const SETTINGS_CATEGORY_SECTIONS: Record<string, string[]> = {
  interface: ['settings-appearance', 'settings-display'],
  model: ['settings-llm', 'settings-llm-retry'],
  agent: [
    'settings-command-policy',
    'settings-agent-system-prompt',
    'settings-notification',
  ],
  tools: ['settings-experimental'],
  transfer: ['settings-transfer'],
  plugins: ['settings-plugins'],
  market: ['settings-market'],
  sync: ['settings-sync'],
  about: ['settings-about'],
};

export function getSettingsCategoryLabel(id: string) {
  return SETTINGS_CATEGORIES.find((category) => category.id === id)?.label ?? '设置';
}
