import type { AgentMode, RiskLevel } from './types';

export const APP_NAME = 'Marcel SSH';

export const DEFAULT_PORT = 22;
export const DEFAULT_FONT_SIZE = 14;
export const DEFAULT_FONT_FAMILY = 'JetBrains Mono, Fira Code, Consolas, "Microsoft YaHei", monospace';

export const AGENT_MODES: { value: AgentMode; label: string; description: string }[] = [
  { value: 'chat', label: 'CHAT', description: '纯聊天模式，AI 仅回答问题，不执行任何工具或命令' },
  { value: 'agent', label: 'AGENT', description: 'AI 可调用工具，命令执行受黑/白名单约束（在设置中配置）' },
  { value: 'auto', label: 'AUTO', description: 'AI 自主规划并执行所有工具调用，不再请求确认' },
];

export const RISK_LEVEL_COLORS: Record<RiskLevel, string> = {
  readonly: 'bg-emerald-600 text-emerald-100',
  low_risk: 'bg-sky-600 text-sky-100',
  moderate: 'bg-amber-600 text-amber-100',
  high_risk: 'bg-orange-600 text-orange-100',
  destructive: 'bg-red-600 text-red-100',
};

export const RISK_LEVEL_LABELS: Record<RiskLevel, string> = {
  readonly: '只读',
  low_risk: '低风险',
  moderate: '中等风险',
  high_risk: '高风险',
  destructive: '破坏性',
};

export const TERMINAL_THEMES = {
  dark: {
    background: '#18181b',
    foreground: '#e4e4e7',
    cursor: '#a1a1aa',
    cursorAccent: '#18181b',
    selectionBackground: '#3f3f46',
    black: '#27272a',
    red: '#ef4444',
    green: '#22c55e',
    yellow: '#eab308',
    blue: '#3b82f6',
    magenta: '#a855f7',
    cyan: '#06b6d4',
    white: '#e4e4e7',
    brightBlack: '#52525b',
    brightRed: '#f87171',
    brightGreen: '#4ade80',
    brightYellow: '#facc15',
    brightBlue: '#60a5fa',
    brightMagenta: '#c084fc',
    brightCyan: '#22d3ee',
    brightWhite: '#fafafa',
  },
  light: {
    background: '#ffffff',
    foreground: '#18181b',
    cursor: '#18181b',
    cursorAccent: '#ffffff',
    selectionBackground: '#e4e4e7',
    black: '#18181b',
    red: '#dc2626',
    green: '#16a34a',
    yellow: '#ca8a04',
    blue: '#2563eb',
    magenta: '#9333ea',
    cyan: '#0891b2',
    white: '#e4e4e7',
    brightBlack: '#52525b',
    brightRed: '#ef4444',
    brightGreen: '#22c55e',
    brightYellow: '#eab308',
    brightBlue: '#3b82f6',
    brightMagenta: '#a855f7',
    brightCyan: '#06b6d4',
    brightWhite: '#fafafa',
  },
};
