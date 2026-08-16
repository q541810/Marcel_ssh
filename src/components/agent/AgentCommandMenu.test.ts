import { describe, expect, it } from 'vitest';
import { buildAgentCommandEntries } from '@/components/agent/agentCommandEntries';
import type { Skill } from '@/lib/types';

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: 's-1',
    name: '代码审查',
    description: '审查代码质量的技能',
    prompt: '请对代码进行审查',
    enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const skills = [
  makeSkill({ id: 's-1', name: '代码审查', description: '审查代码质量' }),
  makeSkill({ id: 's-2', name: 'git 提交', description: '生成中文提交信息', enabled: false }),
];

describe('buildAgentCommandEntries', () => {
  it('shows both groups with all items when query is empty', () => {
    const entries = buildAgentCommandEntries({
      modeSubmenu: false,
      query: '',
      skills,
      currentModeLabel: 'AGENT',
    });
    const headers = entries.filter((e) => e.kind === 'header').map((e) => e.title);
    expect(headers).toEqual(['命令', 'SKILL']);
    const commands = entries.filter((e) => e.kind === 'command').map((e) => e.id);
    expect(commands).toEqual(['toggle-mode', 'compact']);
    const skillNames = entries
      .filter((e) => e.kind === 'skill')
      .map((e) => (e.kind === 'skill' ? e.skill.name : ''));
    expect(skillNames).toEqual(['代码审查', 'git 提交']);
  });

  it('filters commands by Chinese keyword', () => {
    const entries = buildAgentCommandEntries({
      modeSubmenu: false,
      query: '压缩',
      skills,
      currentModeLabel: 'AGENT',
    });
    const commands = entries.filter((e) => e.kind === 'command').map((e) => e.id);
    expect(commands).toEqual(['compact']);
    expect(entries.some((e) => e.kind === 'skill')).toBe(false);
  });

  it('filters commands by english keyword', () => {
    const entries = buildAgentCommandEntries({
      modeSubmenu: false,
      query: 'mode',
      skills,
      currentModeLabel: 'AGENT',
    });
    const commands = entries.filter((e) => e.kind === 'command').map((e) => e.id);
    expect(commands).toEqual(['toggle-mode']);
  });

  it('filters skills by name or description', () => {
    const byName = buildAgentCommandEntries({
      modeSubmenu: false,
      query: 'git',
      skills,
      currentModeLabel: 'AGENT',
    });
    const names = byName
      .filter((e) => e.kind === 'skill')
      .map((e) => (e.kind === 'skill' ? e.skill.name : ''));
    expect(names).toEqual(['git 提交']);
    expect(byName.some((e) => e.kind === 'command')).toBe(false);

    const byDesc = buildAgentCommandEntries({
      modeSubmenu: false,
      query: '质量',
      skills,
      currentModeLabel: 'AGENT',
    });
    const descNames = byDesc
      .filter((e) => e.kind === 'skill')
      .map((e) => (e.kind === 'skill' ? e.skill.name : ''));
    expect(descNames).toEqual(['代码审查']);
  });

  it('returns empty entries when nothing matches', () => {
    const entries = buildAgentCommandEntries({
      modeSubmenu: false,
      query: '不存在的指令',
      skills,
      currentModeLabel: 'AGENT',
    });
    expect(entries).toEqual([]);
  });

  it('enters mode submenu with three modes, no headers', () => {
    const entries = buildAgentCommandEntries({
      modeSubmenu: true,
      query: 'anything',
      skills,
      currentModeLabel: 'AGENT',
    });
    expect(entries.some((e) => e.kind === 'header')).toBe(false);
    expect(entries.filter((e) => e.kind === 'mode')).toHaveLength(3);
    const labels = entries
      .filter((e) => e.kind === 'mode')
      .map((e) => (e.kind === 'mode' ? e.mode.value : ''));
    expect(labels).toEqual(['plan', 'agent', 'auto']);
  });

  it('hides command group when filtered empty but keeps skill group', () => {
    const entries = buildAgentCommandEntries({
      modeSubmenu: false,
      query: '代码审查',
      skills,
      currentModeLabel: 'AGENT',
    });
    const headers = entries.filter((e) => e.kind === 'header').map((e) => e.title);
    expect(headers).toEqual(['SKILL']);
    expect(entries.filter((e) => e.kind === 'command')).toHaveLength(0);
  });
});
