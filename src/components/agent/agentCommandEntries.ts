import { AGENT_MODES } from '@/lib/constants';
import { isBuiltinSkill, sortSkillsForDisplay } from '@/lib/builtinSkills';
import type { AgentMode, Skill } from '@/lib/types';

/**
 * `/` 命令面板的条目模型与过滤逻辑（纯函数，与组件解耦以便单测）。
 */

export type MenuEntry =
  | { kind: 'header'; title: string }
  | { kind: 'command'; id: 'toggle-mode' | 'compact'; label: string; keywords: string[]; hint?: string }
  | { kind: 'skill'; skill: Skill }
  | { kind: 'mode'; mode: (typeof AGENT_MODES)[number] };

function matchesCommand(label: string, keywords: string[], query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    label.toLowerCase().includes(q) ||
    keywords.some((k) => k.toLowerCase().includes(q))
  );
}

/**
 * 构建命令面板条目（分组 + 过滤）。
 * - query 为空：命令 + 全部 skill 两组
 * - query 非空：命令按 label/keywords 匹配，skill 按 name/description 匹配
 * - modeSubmenu：进入三模式子菜单（无分组标题）
 */
export function buildAgentCommandEntries(opts: {
  modeSubmenu: boolean;
  query: string;
  skills: Skill[];
  currentModeLabel: string;
}): MenuEntry[] {
  const { modeSubmenu, query, skills, currentModeLabel } = opts;
  if (modeSubmenu) {
    return AGENT_MODES.map((m) => ({ kind: 'mode' as const, mode: m }));
  }
  const q = query.trim().toLowerCase();
  const commandEntries: MenuEntry[] = [];
  if (matchesCommand('切换 Agent 模式', ['mode', '模式', 'agent', 'plan', 'auto'], q)) {
    commandEntries.push({
      kind: 'command',
      id: 'toggle-mode',
      label: '切换 Agent 模式',
      keywords: ['mode', '模式', 'agent', 'plan', 'auto'],
      hint: `当前：${currentModeLabel}`,
    });
  }
  if (matchesCommand('压缩上下文', ['compact', '压缩', 'context', '上下文'], q)) {
    commandEntries.push({
      kind: 'command',
      id: 'compact',
      label: '压缩上下文',
      keywords: ['compact', '压缩', 'context', '上下文'],
    });
  }
  // 内置教学 skill 供 AI 调用，不进 `/` 插入面板；用户 skill 按手动排序展示
  const skillEntries: MenuEntry[] = sortSkillsForDisplay(skills)
    .filter((s) => !isBuiltinSkill(s))
    .filter(
      (s) =>
        !q ||
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q),
    )
    .map((skill) => ({ kind: 'skill' as const, skill }));

  const result: MenuEntry[] = [];
  if (commandEntries.length > 0) {
    result.push({ kind: 'header', title: '命令' }, ...commandEntries);
  }
  if (skillEntries.length > 0) {
    result.push({ kind: 'header', title: 'SKILL' }, ...skillEntries);
  }
  return result;
}

/** 当前模式的中文标签（面板「切换 Agent 模式」的提示用）。 */
export function agentModeLabel(mode: AgentMode): string {
  return AGENT_MODES.find((m) => m.value === mode)?.label ?? '';
}
