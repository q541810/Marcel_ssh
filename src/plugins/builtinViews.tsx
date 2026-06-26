import { Terminal, Wand, Plug, Settings } from 'lucide-react';
import type { ViewProvider } from '@/lib/types';
import { useViewStore } from '@/stores/viewStore';

const BUILTIN_PLUGIN_ID = 'builtin';

export function registerBuiltinViews(): void {
  const store = useViewStore.getState();
  const providers: ViewProvider[] = [
    {
      id: 'builtin.sessions',
      pluginId: BUILTIN_PLUGIN_ID,
      mount: 'sidebar',
      title: '会话',
      icon: { kind: 'react', node: <Terminal className="w-5 h-5" /> },
      navGroup: 'top',
      order: 10,
      component: async () => ({
        default: (await import('@/components/connection/ConnectionList')).default,
      }),
    },
    {
      id: 'builtin.skills',
      pluginId: BUILTIN_PLUGIN_ID,
      mount: 'sidebar',
      title: '技能',
      icon: { kind: 'react', node: <Wand className="w-5 h-5" /> },
      navGroup: 'top',
      order: 20,
      component: async () => ({
        default: (await import('@/components/skill/SkillList')).default,
      }),
    },
    {
      id: 'builtin.mcp',
      pluginId: BUILTIN_PLUGIN_ID,
      mount: 'sidebar',
      title: '自定义 MCP',
      icon: { kind: 'react', node: <Plug className="w-5 h-5" /> },
      navGroup: 'top',
      order: 30,
      component: async () => ({
        default: (await import('@/components/mcp/McpList')).default,
      }),
    },
    {
      id: 'builtin.terminal',
      pluginId: BUILTIN_PLUGIN_ID,
      mount: 'center',
      title: '终端',
      icon: { kind: 'react', node: <Terminal className="w-5 h-5" /> },
      order: 10,
      component: async () => ({
        default: (await import('@/components/terminal/Terminal')).default,
      }),
    },
    {
      id: 'builtin.settings',
      pluginId: BUILTIN_PLUGIN_ID,
      mount: 'center',
      title: '设置',
      icon: { kind: 'react', node: <Settings className="w-5 h-5" /> },
      navGroup: 'bottom',
      order: 20,
      exclusive: true,
      component: async () => ({
        default: (await import('@/components/settings/Settings')).default,
      }),
    },
    {
      id: 'builtin.agent',
      pluginId: BUILTIN_PLUGIN_ID,
      mount: 'agent',
      title: 'Agent',
      icon: { kind: 'react', node: <Wand className="w-5 h-5" /> },
      order: 10,
      component: async () => ({
        default: (await import('@/components/agent/AgentPanel')).default,
      }),
    },
  ];
  for (const p of providers) store.register(p);
}
