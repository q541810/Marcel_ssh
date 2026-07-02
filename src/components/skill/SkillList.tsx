import { useEffect, useState, useCallback } from 'react';
import { useSkillStore } from '@/stores/skillStore';
import type { Skill } from '@/lib/types';
import ListPanel from '@/components/ui/ListPanel';
import ContextMenu from '@/components/ui/ContextMenu';
import Toggle from '@/components/ui/Toggle';
import SkillCreateModal from './SkillCreateModal';
import SkillEditModal from './SkillEditModal';

// ---------- SkillCard ----------

interface SkillCardProps {
  skill: Skill;
  onToggle: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onContextMenu: (e: React.MouseEvent, skill: Skill) => void;
}

function SkillCard({ skill, onToggle, onDelete, onEdit, onContextMenu }: SkillCardProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      onContextMenu={(e) => onContextMenu(e, skill)}
      className={
        'group rounded-lg border transition-colors px-2 py-2 ' +
        (skill.enabled
          ? 'bg-indigo-900/20 border-indigo-700/50 hover:border-indigo-700'
          : 'bg-zinc-900/40 border-zinc-800 hover:border-zinc-700')
      }
    >
      <div className='flex items-center gap-2'>
        <Toggle checked={skill.enabled} onChange={onToggle} size="sm" />
        <button
          onClick={() => setExpanded((v) => !v)}
          className='flex-1 min-w-0 text-left'
        >
          <div className='text-sm font-medium text-zinc-200 truncate'>{skill.name}</div>
          {skill.description && (
            <div className='text-xs text-zinc-500 truncate'>{skill.description}</div>
          )}
        </button>
        <button
          onClick={onEdit}
          title='编辑'
          className='flex-shrink-0 p-1 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 opacity-0 group-hover:opacity-100 transition-all'
        >
          <svg className='w-3.5 h-3.5' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
            <path strokeLinecap='round' strokeLinejoin='round' strokeWidth={2}
              d='M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z' />
          </svg>
        </button>
        <button
          onClick={onDelete}
          title='删除'
          className='flex-shrink-0 p-1 rounded-md text-zinc-500 hover:text-red-400 hover:bg-zinc-800 opacity-0 group-hover:opacity-100 transition-all'
        >
          <svg className='w-3.5 h-3.5' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
            <path strokeLinecap='round' strokeLinejoin='round' strokeWidth={2}
              d='M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3' />
          </svg>
        </button>
      </div>
      {expanded && (
        <pre className='mt-2 text-xs text-zinc-400 whitespace-pre-wrap break-words font-sans px-1'>
{skill.prompt}
        </pre>
      )}
    </div>
  );
}

// ---------- Main ----------

export default function SkillList() {
  const skills = useSkillStore((s) => s.skills);
  const loading = useSkillStore((s) => s.loading);
  const error = useSkillStore((s) => s.error);
  const fetchSkills = useSkillStore((s) => s.fetchSkills);
  const addSkill = useSkillStore((s) => s.addSkill);
  const toggleSkill = useSkillStore((s) => s.toggleSkill);
  const deleteSkill = useSkillStore((s) => s.deleteSkill);

  const [searchQuery, setSearchQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; skill: Skill } | null>(null);
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  const filtered = skills.filter(
    (s) =>
      s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.description.toLowerCase().includes(searchQuery.toLowerCase()),
  );
  const enabledCount = skills.filter((s) => s.enabled).length;

  const contextMenuItems = contextMenu
    ? [
        {
          label: '编辑',
          onClick: () => setEditingSkill(contextMenu.skill),
        },
        { divider: true } as { label: string; onClick: () => void; variant?: 'default' | 'danger'; divider?: boolean },
        {
          label: '删除',
          variant: 'danger' as const,
          onClick: () => {
            if (confirm('确定删除技能 ' + contextMenu.skill.name + ' ?')) {
              deleteSkill(contextMenu.skill.id);
            }
          },
        },
      ]
    : [];

  return (
    <ListPanel
      data-region="skills"
      title="技能"
      onAdd={() => setCreateOpen(true)}
      addButtonTitle="新建技能"
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      searchPlaceholder="搜索技能..."
      status={
        (skills.length > 0 || error) ? (
          <>
            {skills.length > 0 && (
              <span>{skills.length} 个技能 · {enabledCount} 个已启用</span>
            )}
            {error && <div className="mt-1 text-red-400">{error}</div>}
          </>
        ) : undefined
      }
    >
      <div className="space-y-1">
        {loading && skills.length === 0 && (
          <p className='text-sm text-zinc-500 text-center mt-4'>加载中...</p>
        )}

        {!loading && skills.length === 0 && (
          <div className='text-center mt-6 px-3'>
            <p className='text-sm text-zinc-500 mb-3'>暂无技能</p>
            <button
              onClick={() => setCreateOpen(true)}
              className='text-xs text-indigo-400 hover:text-indigo-300 underline'
            >
              创建技能
            </button>
          </div>
        )}

        {filtered.map((skill) => (
          <SkillCard
            key={skill.id}
            skill={skill}
            onToggle={() => toggleSkill(skill.id)}
            onDelete={() => {
              if (confirm('确定删除技能 ' + skill.name + ' ?')) deleteSkill(skill.id);
            }}
            onEdit={() => setEditingSkill(skill)}
            onContextMenu={(e, s) => {
              e.preventDefault();
              setContextMenu({ x: e.clientX, y: e.clientY, skill: s });
            }}
          />
        ))}

        {!loading && skills.length > 0 && filtered.length === 0 && (
          <p className='text-sm text-zinc-500 text-center mt-4'>无匹配技能</p>
        )}
      </div>

      {/* Create modal */}
      <SkillCreateModal open={createOpen} onClose={() => setCreateOpen(false)} />

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={closeContextMenu}
        />
      )}

      {/* Edit modal */}
      {editingSkill && (
        <SkillEditModal
          skill={editingSkill}
          open={!!editingSkill}
          onClose={() => setEditingSkill(null)}
        />
      )}
    </ListPanel>
  );
}
