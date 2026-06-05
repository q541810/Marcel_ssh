import type { AgentMode, RiskLevel, TerminalColors } from './types';

export const APP_NAME = 'Marcel SSH';

/** Maximum file size (in bytes) that can be opened in the remote file editor. */
export const MAX_EDITOR_FILE_SIZE = 2 * 1024 * 1024;

/** File extensions that should not be opened in the text editor (binary formats). */
export const BINARY_EXTENSIONS = new Set([
  '.gz', '.zip', '.tar', '.tgz', '.bz2', '.xz', '.zst', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.o', '.a', '.lib',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tiff', '.tif',
  '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.flv', '.wav', '.flac', '.ogg', '.wma',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.iso', '.dmg', '.deb', '.rpm', '.msi',
  '.sqlite', '.db', '.woff', '.woff2', '.eot', '.ttf', '.otf',
  '.class', '.jar', '.war', '.pyc', '.pyd',
]);

export const DEFAULT_PORT = 22;
export const DEFAULT_FONT_SIZE = 14;
export const DEFAULT_FONT_FAMILY = 'JetBrains Mono, Fira Code, Consolas, "Microsoft YaHei", monospace';

export const AGENT_MODES: { value: AgentMode; label: string; description: string }[] = [
  { value: 'chat', label: 'CHAT', description: '纯聊天模式，AI 仅回答问题，不执行任何工具或命令' },
  { value: 'agent', label: 'AGENT', description: 'AI 可调用工具，命令执行受黑/白名单约束（在设置中配置）' },
  { value: 'auto', label: 'AUTO', description: 'AI 自主规划并执行所有工具调用，不再请求确认' },
];

export const RISK_LEVEL_COLORS: Record<RiskLevel, string> = {
  ReadOnly: 'bg-emerald-600 text-emerald-100',
  LowRisk: 'bg-sky-600 text-sky-100',
  Moderate: 'bg-amber-600 text-amber-100',
  HighRisk: 'bg-orange-600 text-orange-100',
  Destructive: 'bg-red-600 text-red-100',
};

export const RISK_LEVEL_LABELS: Record<RiskLevel, string> = {
  ReadOnly: '只读',
  LowRisk: '低风险',
  Moderate: '中等风险',
  HighRisk: '高风险',
  Destructive: '破坏性',
};

export const TERMINAL_COLOR_PRESETS: { name: string; colors: TerminalColors }[] = [
  {
    name: '暗色',
    colors: {
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
  },
  {
    name: '亮色',
    colors: {
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
  },
  {
    name: 'Dracula',
    colors: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      cursorAccent: '#282a36',
      selectionBackground: '#44475a',
      black: '#21222c',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
      brightBlack: '#6272a4',
      brightRed: '#ff6e6e',
      brightGreen: '#69ff94',
      brightYellow: '#ffffa5',
      brightBlue: '#d6acff',
      brightMagenta: '#ff92df',
      brightCyan: '#a4ffff',
      brightWhite: '#ffffff',
    },
  },
  {
    name: 'One Dark',
    colors: {
      background: '#1e2127',
      foreground: '#abb2bf',
      cursor: '#abb2bf',
      cursorAccent: '#1e2127',
      selectionBackground: '#3e4451',
      black: '#1e2127',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#d19a66',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#abb2bf',
      brightBlack: '#5c6370',
      brightRed: '#e06c75',
      brightGreen: '#98c379',
      brightYellow: '#d19a66',
      brightBlue: '#61afef',
      brightMagenta: '#c678dd',
      brightCyan: '#56b6c2',
      brightWhite: '#ffffff',
    },
  },
  {
    name: 'Monokai',
    colors: {
      background: '#272822',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      cursorAccent: '#272822',
      selectionBackground: '#49483e',
      black: '#272822',
      red: '#f92672',
      green: '#a6e22e',
      yellow: '#f4bf75',
      blue: '#66d9ef',
      magenta: '#ae81ff',
      cyan: '#a1efe4',
      white: '#f8f8f2',
      brightBlack: '#75715e',
      brightRed: '#f92672',
      brightGreen: '#a6e22e',
      brightYellow: '#f4bf75',
      brightBlue: '#66d9ef',
      brightMagenta: '#ae81ff',
      brightCyan: '#a1efe4',
      brightWhite: '#f9f8f5',
    },
  },
  {
    name: 'Nord',
    colors: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#d8dee9',
      cursorAccent: '#2e3440',
      selectionBackground: '#434c5e',
      black: '#3b4252',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      white: '#e5e9f0',
      brightBlack: '#4c566a',
      brightRed: '#bf616a',
      brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1',
      brightMagenta: '#b48ead',
      brightCyan: '#8fbcbb',
      brightWhite: '#eceff4',
    },
  },
  {
    name: 'Solarized Dark',
    colors: {
      background: '#002b36',
      foreground: '#839496',
      cursor: '#839496',
      cursorAccent: '#002b36',
      selectionBackground: '#073642',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#002b36',
      brightRed: '#cb4b16',
      brightGreen: '#586e75',
      brightYellow: '#657b83',
      brightBlue: '#839496',
      brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1',
      brightWhite: '#fdf6e3',
    },
  },
  {
    name: 'Gruvbox',
    colors: {
      background: '#282828',
      foreground: '#ebdbb2',
      cursor: '#ebdbb2',
      cursorAccent: '#282828',
      selectionBackground: '#665c54',
      black: '#282828',
      red: '#cc241d',
      green: '#98971a',
      yellow: '#d79921',
      blue: '#458588',
      magenta: '#b16286',
      cyan: '#689d6a',
      white: '#a89984',
      brightBlack: '#928374',
      brightRed: '#fb4934',
      brightGreen: '#b8bb26',
      brightYellow: '#fabd2f',
      brightBlue: '#83a598',
      brightMagenta: '#d3869b',
      brightCyan: '#8ec07c',
      brightWhite: '#ebdbb2',
    },
  },
];

export const DEFAULT_TERMINAL_COLORS = TERMINAL_COLOR_PRESETS[0].colors;

export interface BottomTab {
  id: string;
  icon: string;
  label: string;
}

export const BOTTOM_TABS: BottomTab[] = [
  { id: 'quick-command', icon: 'M13 10V3L4 14h7v7l9-11h-7z', label: '快捷指令' },
  { id: 'process', icon: 'M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z', label: '进程管理' },
  { id: 'file-manager', icon: 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z', label: '文件管理' },
];
