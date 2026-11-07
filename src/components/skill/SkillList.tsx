import { useEffect, useState, useCallback, useMemo } from 'react';
import { Pencil, Sparkles, Trash2 } from 'lucide-react';
import { useSkillStore } from '@/stores/skillStore';
import type { Skill } from '@/lib/types';
import { isBuiltinSkill, sortSkillsForDisplay } from '@/lib/builtinSkills';
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
  draggable?: boolean;
  dragging?: boolean;
  indicatorAbove?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
  onDragOver?: (e: React.DragEvent) => void;
}

function SkillCard({
  skill,
  onToggle,
  onDelete,
  onEdit,
  onContextMenu,
  draggable,
  dragging,
  indicatorAbove,
  onDragStart,
  onDragEnd,
  onDragOver,
}: SkillCardProps) {
  const [expanded, setExpanded] = useState(false);
  const builtin = isBuiltinSkill(skill);

  return (
    <>
      {indicatorAbove && (
        <div className='h-0.5 rounded-full bg-indigo-400 mx-1' aria-hidden />
      )}
      <div
        onContextMenu={(e) => onContextMenu(e, skill)}
        draggable={draggable}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        className={
          'group rounded-xl border transition-colors p-4 ' +
          (skill.enabled
            ? 'bg-indigo-900/20 border-indigo-700/50 hover:border-indigo-700'
            : 'bg-surface-raised border-edge-subtle hover:border-edge') +
          (draggable ? ' cursor-grab active:cursor-grabbing' : '') +
          (dragging ? ' opacity-40' : '')
        }
      >
        <div className='flex items-center gap-2'>
          <Toggle checked={skill.enabled} onChange={onToggle} size="sm" />
          <button
            onClick={() => setExpanded((v) => !v)}
            className='flex-1 min-w-0 text-left'
          >
            <div className='flex items-center gap-2 min-w-0'>
              <span className='text-body font-medium text-fg truncate'>{skill.name}</span>
              {builtin && (
                <span className='flex-shrink-0 rounded px-1 py-px text-caption leading-4 bg-surface-raised text-fg-secondary border border-edge'>
                  内置
                </span>
              )}
              {skill.resources && skill.resources.length > 0 && (
                <span
                  title={`含 ${skill.resources.length} 个资源文件`}
                  className='flex-shrink-0 rounded px-1 py-px text-caption leading-4 bg-surface-raised text-fg-secondary border border-edge'
                >
                  {skill.resources.length} 资源
                </span>
              )}
            </div>
            {skill.description && (
              <div className='text-meta text-fg-tertiary truncate'>{skill.description}</div>
            )}
          </button>
          {!builtin && (
            <>
              <button
                onClick={onEdit}
                title='编辑'
                className='flex-shrink-0 p-1 rounded-md text-fg-tertiary hover:text-fg hover:bg-state-soft opacity-0 group-hover:opacity-100 transition'
              >
                <Pencil size={14} strokeWidth={1.5} />
              </button>
              <button
                onClick={onDelete}
                title='删除'
                className='flex-shrink-0 p-1 rounded-md text-fg-tertiary hover:text-red-400 hover:bg-state-soft opacity-0 group-hover:opacity-100 transition'
              >
                <Trash2 size={14} strokeWidth={1.5} />
              </button>
            </>
          )}
        </div>
        {expanded && (
          <>
            <pre className='mt-2 text-meta text-fg-secondary whitespace-pre-wrap break-words font-sans px-1'>
{skill.prompt}
            </pre>
            {skill.resources && skill.resources.length > 0 && (
              <div className='mt-2 px-1 text-caption text-fg-tertiary break-words'>
                附属资源：{skill.resources.map((r) => r.path).join('、')}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

// ---------- Main ----------

export default function SkillList() {
  const skills = useSkillStore((s) => s.skills);
  const loading = useSkillStore((s) => s.loading);
  const error = useSkillStore((s) => s.error);
  const fetchSkills = useSkillStore((s) => s.fetchSkills);
  const toggleSkill = useSkillStore((s) => s.toggleSkill);
  const deleteSkill = useSkillStore((s) => s.deleteSkill);
  const reorderSkills = useSkillStore((s) => s.reorderSkills);

  const [searchQuery, setSearchQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; skill: Skill } | null>(null);
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null);
  // 拖拽排序状态：dragId = 被拖拽的 skill；dropIndex = 在「可见用户 skill 序列」中的插入位
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  // 展示顺序：内置置顶，用户按手动排序
  const sorted = useMemo(() => sortSkillsForDisplay(skills), [skills]);
  const allUsers = useMemo(() => sorted.filter((s) => !isBuiltinSkill(s)), [sorted]);

  const filtered = useMemo(
    () =>
      sorted.filter(
        (s) =>
          s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.description.toLowerCase().includes(searchQuery.toLowerCase()),
      ),
    [sorted, searchQuery],
  );
  const filteredUsers = useMemo(() => filtered.filter((s) => !isBuiltinSkill(s)), [filtered]);

  const enabledCount = skills.filter((s) => s.enabled).length;

  // ── 拖拽 ──

  const handleDragStart = useCallback(
    (skill: Skill) => (e: React.DragEvent) => {
      if (isBuiltinSkill(skill)) return;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', skill.id);
      setDragId(skill.id);
      setDropIndex(null);
    },
    [],
  );

  const handleDragEnd = useCallback(() => {
    setDragId(null);
    setDropIndex(null);
  }, []);

  const handleDragOverUser = useCallback(
    (userIndexVisible: number) => (e: React.DragEvent) => {
      if (!dragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = e.currentTarget.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      // 插入位在「去掉被拖拽项」的序列中计算，避免经过自身时的 off-by-one
      const dragIdx = filteredUsers.findIndex((s) => s.id === dragId);
      let idx = userIndexVisible + (after ? 1 : 0);
      if (dragIdx !== -1 && userIndexVisible > dragIdx) idx -= 1;
      setDropIndex(idx);
    },
    [dragId, filteredUsers],
  );

  // 内置卡片区域：插入点只能在其下方（index 0）
  const handleDragOverBuiltin = useCallback(
    (e: React.DragEvent) => {
      if (!dragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDropIndex(0);
    },
    [dragId],
  );

  const commitDrop = useCallback(() => {
    if (!dragId || dropIndex == null) return;
    const visibleOthers = filteredUsers.filter((s) => s.id !== dragId);
    const rest = allUsers.map((s) => s.id).filter((id) => id !== dragId);
    let newOrder: string[];
    if (dropIndex >= visibleOthers.length || visibleOthers.length === 0) {
      newOrder = [...rest, dragId];
    } else {
      const anchor = visibleOthers[dropIndex].id;
      newOrder = [...rest];
      newOrder.splice(newOrder.indexOf(anchor), 0, dragId);
    }
    void reorderSkills(newOrder);
    setDragId(null);
    setDropIndex(null);
  }, [dragId, dropIndex, filteredUsers, allUsers, reorderSkills]);

  // ── 右键菜单 ──

  const contextUserIdx =
    contextMenu && !isBuiltinSkill(contextMenu.skill)
      ? allUsers.findIndex((u) => u.id === contextMenu.skill.id)
      : -1;

  const moveUser = useCallback(
    (idx: number, delta: -1 | 1) => {
      const ids = allUsers.map((u) => u.id);
      const target = idx + delta;
      if (target < 0 || target >= ids.length) return;
      [ids[idx], ids[target]] = [ids[target], ids[idx]];
      void reorderSkills(ids);
    },
    [allUsers, reorderSkills],
  );

  const contextMenuItems = contextMenu
    ? isBuiltinSkill(contextMenu.skill)
      ? [
          {
            label: contextMenu.skill.enabled ? '禁用' : '启用',
            onClick: () => toggleSkill(contextMenu.skill.id),
          },
        ]
      : [
          ...(contextUserIdx > 0
            ? [{ label: '上移', onClick: () => moveUser(contextUserIdx, -1) }]
            : []),
          ...(contextUserIdx !== -1 && contextUserIdx < allUsers.length - 1
            ? [{ label: '下移', onClick: () => moveUser(contextUserIdx, 1) }]
            : []),
          {
            label: '编辑',
            onClick: () => setEditingSkill(contextMenu.skill),
          },
          { divider: true } as { label: string; onClick: () => void; variant?: 'default' | 'danger'; divider?: boolean },
          {
            label: '删除',
            variant: 'danger' as const,
            onClick: () => {
              if (confirm('确定删除 skill ' + contextMenu.skill.name + ' ?')) {
                deleteSkill(contextMenu.skill.id);
              }
            },
          },
        ]
    : [];

  // 渲染时跟踪用户卡片的可见序号，用于放置指示线
  let visibleUserCursor = 0;
  const dragVisIdx = dragId ? filteredUsers.findIndex((s) => s.id === dragId) : -1;

  return (
    <ListPanel
      data-region="skills"
      title="Skill"
      onAdd={() => setCreateOpen(true)}
      addButtonTitle="新建 Skill"
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      searchPlaceholder="搜索 skill..."
      status={
        (skills.length > 0 || error) ? (
          <>
            {skills.length > 0 && (
              <span>{skills.length} 个 skill · {enabledCount} 个已启用</span>
            )}
            {error && <div className="mt-1 text-red-400">{error}</div>}
          </>
        ) : undefined
      }
    >
      <div
        className="space-y-1"
        onDrop={(e) => {
          e.preventDefault();
          commitDrop();
        }}
        onDragOver={(e) => {
          if (!dragId) return;
          e.preventDefault();
        }}
      >
        {loading && skills.length === 0 && (
          <div className="space-y-2 px-1 mt-2" aria-label='加载中...'>
            <div className="h-12 rounded-lg bg-state-soft animate-pulse" />
            <div className="h-12 rounded-lg bg-state-soft animate-pulse" />
            <div className="h-12 rounded-lg bg-state-soft animate-pulse" />
          </div>
        )}

        {!loading && skills.length === 0 && (
          <div className='text-center mt-6 px-3'>
            <Sparkles size={24} strokeWidth={1.5} className='mx-auto mb-2 text-fg-tertiary' />
            <p className='text-body text-fg-secondary mb-3'>暂无 skill</p>
            <button
              onClick={() => setCreateOpen(true)}
              className='text-meta text-indigo-400 hover:text-indigo-300 underline'
            >
              创建 Skill
            </button>
          </div>
        )}

        {filtered.map((skill) => {
          const builtin = isBuiltinSkill(skill);
          const userIdx = builtin ? -1 : visibleUserCursor++;
          // 与 handleDragOverUser 一致：换算到「去掉被拖拽项」的序列空间
          const adjIdx =
            !builtin && dragVisIdx !== -1 && userIdx > dragVisIdx
              ? userIdx - 1
              : userIdx;
          const showIndicator =
            dragId != null &&
            dropIndex === adjIdx &&
            !builtin &&
            skill.id !== dragId;
          return (
            <SkillCard
              key={skill.id}
              skill={skill}
              onToggle={() => toggleSkill(skill.id)}
              onDelete={() => {
                if (confirm('确定删除 skill ' + skill.name + ' ?')) deleteSkill(skill.id);
              }}
              onEdit={() => setEditingSkill(skill)}
              onContextMenu={(e, s) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, skill: s });
              }}
              draggable={!builtin}
              dragging={skill.id === dragId}
              indicatorAbove={showIndicator}
              onDragStart={handleDragStart(skill)}
              onDragEnd={handleDragEnd}
              onDragOver={builtin ? handleDragOverBuiltin : handleDragOverUser(userIdx)}
            />
          );
        })}

        {/* 列表末尾放置区：拖到所有卡片之下 */}
        {dragId != null && dropIndex != null && dropIndex >= filteredUsers.length - 1 && (
          <div className='h-0.5 rounded-full bg-indigo-400 mx-1' aria-hidden />
        )}
        {dragId != null && (
          <div
            className='h-6'
            aria-hidden
            onDragOver={(e) => {
              if (!dragId) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setDropIndex(filteredUsers.length - 1);
            }}
          />
        )}

        {!loading && skills.length > 0 && filtered.length === 0 && (
          <p className='text-body text-fg-tertiary text-center mt-4'>无匹配 skill</p>
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
