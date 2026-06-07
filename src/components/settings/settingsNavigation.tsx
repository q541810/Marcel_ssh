import type React from 'react';
import { Bot, Cpu, Info, Monitor, UploadCloud, Wrench } from 'lucide-react';

export interface SettingsCategory {
  id: string;
  label: string;
  icon: React.ReactNode;
  sections: string[];
}

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
    sections: ['settings-command-policy', 'settings-notification'],
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
    id: 'about',
    label: '关于',
    icon: <Info className="w-4 h-4" />,
    sections: ['settings-about'],
  },
];

export const SETTINGS_CATEGORY_SECTIONS: Record<string, string[]> = {
  interface: ['settings-appearance', 'settings-display'],
  model: ['settings-llm', 'settings-llm-retry'],
  agent: ['settings-command-policy', 'settings-notification'],
  tools: ['settings-experimental'],
  transfer: ['settings-transfer'],
  about: ['settings-about'],
};

export function getSettingsCategoryLabel(id: string) {
  return SETTINGS_CATEGORIES.find((category) => category.id === id)?.label ?? '设置';
}
