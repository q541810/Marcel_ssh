import { useEffect, useState, useCallback } from 'react';
import { useSkillStore } from '@/stores/skillStore';
import type { Skill } from '@/lib/types';
import SkillCreateModal from './SkillCreateModal';
import SkillEditModal from './SkillEditModal';

// ---------- SkillCard ----------

interface SkillCardProps {
  skill: Skill;
  onToggle: () => void;
  onDelete: () => void;
  onContextMenu: (e: React.MouseEvent, skill: Skill) => void;
}

function SkillCard({ skill, onToggle, onDelete, onContextMenu }: SkillCardProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      onContextMenu={(e) => onContextMenu(e, skill)}
      className={
        'group rounded-lg border transition-colors px-2 py-2 ' +
        (skill.enabled
          ? 'bg-indigo-900/20 border-indigo-700/50 hover:border-indigo-700'
          : 'bg-zinc-800/40 border-transparent hover:border-zinc-700')
      }
    >
      <div className='flex items-center gap-2'>
        <button
          onClick={onToggle}
          title={skill.enabled ? '禁用' : '启用'}
          className={
            'flex-shrink-0 relative w-7 h-4 rounded-full transition-colors ' +
            (skill.enabled ? 'bg-indigo-500' : 'bg-zinc-700')
          }
        >
          <span
            className={
              'absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ' +
              (skill.enabled ? 'left-3.5' : 'left-0.5')
            }
          />
        </button>
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
    const handler = () => closeContextMenu();
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [closeContextMenu]);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  const filtered = skills.filter(
    (s) =>
      s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.description.toLowerCase().includes(searchQuery.toLowerCase()),
  );
  const enabledCount = skills.filter((s) => s.enabled).length;

  return (
    <div className='flex flex-col h-full'>
      {/* Header */}
      <div className='flex items-center justify-between px-3 py-2 border-b border-zinc-800'>
        <h2 className='text-xs font-semibold text-zinc-400 uppercase tracking-wider'>
          技能
        </h2>
        <div className='flex items-center gap-1'>
          {/* Create new */}
          <button
            onClick={() => setCreateOpen(true)}
            className='p-1 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 transition-colors'
            title='新建技能'
            aria-label='新建技能'
          >
            <svg className='w-4 h-4' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
              <path strokeLinecap='round' strokeLinejoin='round' strokeWidth={2}
                d='M12 4v16m8-8H4' />
            </svg>
          </button>
        </div>
      </div>

      {/* Search */}
      <div className='p-2 border-b border-zinc-800'>
        <input
          type='text'
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder='搜索技能...'
          className='w-full rounded-lg bg-zinc-800 border border-zinc-700 px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500'
        />
      </div>

      {/* Status row */}
      {(skills.length > 0 || error) && (
        <div className='px-3 py-1.5 border-b border-zinc-800/50 text-xs text-zinc-500'>
          {skills.length > 0 && (
            <span>{skills.length} 个技能 · {enabledCount} 个已启用</span>
          )}
          {error && <div className='mt-1 text-red-400'>{error}</div>}
        </div>
      )}

      {/* List */}
      <div className='flex-1 overflow-y-auto p-2 space-y-1'>
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
        <div
          className="fixed z-50 bg-zinc-800 border border-zinc-700 rounded-xl shadow-lg py-1 min-w-28"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              setEditingSkill(contextMenu.skill);
              closeContextMenu();
            }}
            className="w-full text-left px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700"
          >
            编辑
          </button>
          <hr className="border-zinc-700 my-1" />
          <button
            onClick={() => {
              const s = contextMenu.skill;
              closeContextMenu();
              if (confirm(`确定删除技能 "${s.name}" 吗？`)) deleteSkill(s.id);
            }}
            className="w-full text-left px-3 py-1.5 text-sm text-red-400 hover:bg-zinc-700"
          >
            删除
          </button>
        </div>
      )}

      {/* Edit modal */}
      {editingSkill && (
        <SkillEditModal
          skill={editingSkill}
          open={!!editingSkill}
          onClose={() => setEditingSkill(null)}
        />
      )}
    </div>
  );
}