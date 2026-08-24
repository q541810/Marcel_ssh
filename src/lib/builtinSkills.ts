import type { Skill } from '@/lib/types';

/**
 * 内置教学 skill 识别。
 *
 * 与后端 `src-tauri/src/skills/builtin.rs` 的 BUILTIN_SKILL_PREFIX 保持一致：
 * 内置 skill 使用固定确定性 id（builtin.xxx），不可编辑、不可删除，
 * 只能启用/禁用；内容由应用升级时自动更新。
 */
export const BUILTIN_SKILL_PREFIX = 'builtin.';

export function isBuiltinSkill(skill: Pick<Skill, 'id'>): boolean {
  return skill.id.startsWith(BUILTIN_SKILL_PREFIX);
}

/** 内置 skill 的固定展示顺序；未知内置 id 排在其后（稳定保持相对顺序） */
const BUILTIN_ORDER = [
  'builtin.agent-modes',
  'builtin.model-setup',
  'builtin.extensions',
];

/**
 * 展示排序：内置 skill 固定置顶（按 BUILTIN_ORDER），不被用户 skill 挤下去；
 * 用户 skill 按 position 升序，position 并列时（旧数据默认 0）保持原顺序。
 * Array.prototype.sort 在现代引擎中是稳定排序，直接依赖该行为。
 */
export function sortSkillsForDisplay(skills: Skill[]): Skill[] {
  const builtinRank = (id: string) => {
    const i = BUILTIN_ORDER.indexOf(id);
    return i === -1 ? BUILTIN_ORDER.length : i;
  };
  return [...skills].sort((a, b) => {
    const ab = isBuiltinSkill(a);
    const bb = isBuiltinSkill(b);
    if (ab && bb) return builtinRank(a.id) - builtinRank(b.id);
    if (ab !== bb) return ab ? -1 : 1;
    return a.position - b.position;
  });
}
