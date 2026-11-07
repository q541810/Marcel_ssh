import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Brain, Pin, Plus, Search, SearchX } from 'lucide-react';
import Select from '@/components/ui/Select';
import Toggle from '@/components/ui/Toggle';
import MemoryEditDialog from '@/components/memory/MemoryEditDialog';
import MemoryAssistantLauncher from '@/components/memory/MemoryAssistantLauncher';
import { filterKey, useMemoryManager, type MemoryManager } from '@/components/memory/useMemoryManager';
import { emptyRegistry, modelOptionsByChannel } from '@/lib/llmRegistry';
import {
  KIND_LABELS,
  SOURCE_LABELS,
  relativeTime,
  scopeLabel,
  scopeOf,
  type MemoryFilter,
  type MemoryItem,
  type ScopeEntry,
} from '@/lib/memory';
import type { LlmRegistry, MemorySettings } from '@/lib/types';
import { DEFAULT_MEMORY_SETTINGS } from '@/stores/settingsStore';
import { useConnectionStore } from '@/stores/connectionStore';
import { Card, SettingItem, useSearchRegistry } from './helpers';
import { useSettingsActions } from './SettingsActionsContext';

const SECTION = 'settings-memory';
const MANAGE_SECTION = 'settings-memory-manage';

/** 开关与记忆模型（随设置页的「保存」生效）。 */
export function MemorySection() {
  const { settings, update } = useSettingsActions();
  const ms: MemorySettings = settings.memorySettings ?? DEFAULT_MEMORY_SETTINGS;
  const registry: LlmRegistry = settings.llmRegistry ?? emptyRegistry();
  const slotOptions = useMemo(
    () => [{ value: '', label: '跟随会话使用的模型' }, ...modelOptionsByChannel(registry)],
    [registry],
  );
  const setMs = (patch: Partial<MemorySettings>) => update({ memorySettings: { ...ms, ...patch } });

  return (
    <Card
      id={SECTION}
      title="长期记忆"
      description="Agent 会记住你的习惯、每台机器的情况和踩过的坑，下次在同一台机器上对话时自动带上"
    >
      <SettingItem
        id="memory-enabled"
        label="启用长期记忆"
        description="关闭后对话不再带上记忆，Agent 也不能记新的；已有的记忆保留，随时可以再打开"
        sectionId={SECTION}
        keywords={['记忆', 'memory', '长期记忆', '开关']}
      >
        <Toggle checked={ms.enabled} onChange={(v) => setMs({ enabled: v })} />
      </SettingItem>
      <SettingItem
        id="memory-auto-reflect"
        label="后台复盘"
        description="对话停下 10 分钟、连接断开或上下文压缩时，用记忆模型回顾刚才的对话，把值得记住的记下来（在对话里列出，可撤销）。默认关闭：每次是一次额外的模型调用，花费计入该会话的用量"
        sectionId={SECTION}
        keywords={['记忆', '复盘', 'reflection', '后台', 'token', '用量']}
      >
        <Toggle checked={ms.autoReflect} disabled={!ms.enabled} onChange={(v) => setMs({ autoReflect: v })} />
      </SettingItem>
      <SettingItem
        id="memory-model"
        label="记忆模型"
        description="后台复盘用的模型，留空 = 跟随会话正在用的模型。用便宜的小模型就够"
        sectionId={SECTION}
        keywords={['记忆', '模型', 'memory', 'model', '复盘', '整理助手']}
      >
        <Select
          value={registry.slots.memoryModelId ?? ''}
          onChange={(v) => update({ llmRegistry: { ...registry, slots: { ...registry.slots, memoryModelId: v } } })}
          options={slotOptions}
          placeholder="跟随会话模型"
          className="w-72"
        />
      </SettingItem>
    </Card>
  );
}

/** 整理助手 + 记忆管理（即时生效，不走「保存」：这是数据，不是设置）。 */
export function MemoryManageSection() {
  const manager = useMemoryManager();
  const { register, unregister } = useSearchRegistry();
  useEffect(() => {
    register({
      id: 'memory-manage',
      label: '记忆管理',
      description: '查看、编辑、置顶、删除记忆；整理助手一句话批量整理',
      keywords: ['记忆', 'memory', '整理', '助手', '删除', '编辑'],
      sectionId: MANAGE_SECTION,
    });
    return () => unregister('memory-manage');
  }, [register, unregister]);

  return (
    <div id={MANAGE_SECTION} className="space-y-6">
      <Card title="整理助手" description="一句话让它批量整理：合并重复、删掉过时的、从以前的会话里补记">
        <div className="px-6 py-4">
          <MemoryAssistantLauncher focus={manager.focus} />
        </div>
      </Card>
      <Card title="记忆管理" description="Agent、后台复盘和整理助手记下的东西都在这里；改动下一轮对话就生效">
        <ManageBody manager={manager} />
      </Card>
    </div>
  );
}

function ManageBody({ manager }: { manager: MemoryManager }) {
  const [editing, setEditing] = useState<MemoryItem | null>(null);
  const [creating, setCreating] = useState(false);
  const { directory, filter, setFilter } = manager;

  return (
    <div className="flex min-h-[26rem]">
      <nav className="w-56 shrink-0 space-y-3 border-r border-edge-subtle p-3 text-body" aria-label="记忆作用域">
        <ScopeButton
          label="全部"
          count={directory.total}
          newCount={directory.totalNew}
          active={filter.kind === 'all'}
          onClick={() => setFilter({ kind: 'all' })}
        />
        <ScopeButton
          label="全局"
          hint="关于你本人"
          count={directory.global.count}
          newCount={directory.global.newCount}
          active={isScope(filter, directory.global)}
          onClick={() => setFilter({ kind: 'scope', ref: directory.global.ref })}
        />
        {directory.groups.length > 0 && (
          <ScopeGroup title="分组">
            {directory.groups.map((e) => (
              <ScopeButton key={e.ref.key} label={e.ref.key} count={e.count} newCount={e.newCount}
                active={isScope(filter, e)} onClick={() => setFilter({ kind: 'scope', ref: e.ref })} />
            ))}
          </ScopeGroup>
        )}
        {directory.hosts.length > 0 && (
          <ScopeGroup title="机器">
            {directory.hosts.map((e) => (
              <ScopeButton key={e.ref.key} label={e.label} count={e.count} newCount={e.newCount}
                active={isScope(filter, e)} onClick={() => setFilter({ kind: 'scope', ref: e.ref })} />
            ))}
          </ScopeGroup>
        )}
        {(directory.orphanHosts.length > 0 || directory.orphanGroups.length > 0) && (
          <ScopeGroup title="无主">
            {directory.orphanHosts.length > 0 && (
              <ScopeButton label="已删除的连接" count={directory.orphanHosts.reduce((n, e) => n + e.count, 0)}
                newCount={0} active={filter.kind === 'orphan-hosts'} onClick={() => setFilter({ kind: 'orphan-hosts' })} />
            )}
            {directory.orphanGroups.length > 0 && (
              <ScopeButton label="已不存在的分组" count={directory.orphanGroups.reduce((n, e) => n + e.count, 0)}
                newCount={0} active={filter.kind === 'orphan-groups'} onClick={() => setFilter({ kind: 'orphan-groups' })} />
            )}
          </ScopeGroup>
        )}
      </nav>

      <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-edge bg-surface-raised px-3 py-2 focus-within:border-indigo-500 transition-colors">
            <Search className="h-3.5 w-3.5 shrink-0 text-fg-tertiary" aria-hidden />
            <input
              value={manager.query}
              onChange={(e) => manager.setQuery(e.target.value)}
              placeholder="搜索标题或内容"
              className="min-w-0 flex-1 bg-transparent text-body text-fg placeholder:text-fg-tertiary focus:outline-none"
            />
          </label>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="flex items-center gap-1 rounded-lg bg-surface-raised px-3 py-2 text-body text-fg hover:bg-state-mid transition"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            新增
          </button>
        </div>

        <FilterHeader manager={manager} />

        {manager.undo && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-edge bg-surface-raised/80 px-3 py-2 text-meta animate-fadeIn">
            <span className="min-w-0 truncate text-fg-secondary">{manager.undo.text}</span>
            <div className="flex shrink-0 items-center gap-1">
              <button type="button" onClick={() => void manager.undoLast()}
                className="rounded-md px-2 py-0.5 font-medium text-indigo-300 hover:bg-indigo-500/10 transition">
                撤销
              </button>
              <button type="button" onClick={manager.dismissUndo} aria-label="关闭"
                className="rounded-md px-2 py-0.5 text-fg-tertiary hover:text-fg-secondary transition">
                ×
              </button>
            </div>
          </div>
        )}
        {manager.actionError && <p className="text-meta text-red-400">{manager.actionError}</p>}

        {!manager.loaded ? (
          <p className="py-10 text-center text-body text-fg-tertiary">{manager.loadError ?? '读取中…'}</p>
        ) : manager.items.length === 0 ? (
          <EmptyList manager={manager} />
        ) : (
          <ul key={filterKey(filter)} className="flex flex-col divide-y divide-edge-subtle/80">
            {manager.items.map((m) => (
              <ItemRow key={m.id} item={m} manager={manager} onEdit={() => setEditing(m)} />
            ))}
          </ul>
        )}
      </div>

      <MemoryEditDialog open={!!editing} item={editing} onClose={() => setEditing(null)} />
      <MemoryEditDialog
        open={creating}
        item={null}
        defaultScope={manager.focus ?? undefined}
        onClose={() => setCreating(false)}
      />
    </div>
  );
}

function isScope(filter: MemoryFilter, entry: ScopeEntry) {
  return filter.kind === 'scope' && filter.ref.scope === entry.ref.scope && filter.ref.key === entry.ref.key;
}

function ScopeGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 px-2 text-caption font-medium uppercase tracking-wide text-fg-tertiary">{title}</div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function ScopeButton({
  label, hint, count, newCount, active, onClick,
}: {
  label: string;
  hint?: string;
  count: number;
  newCount: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors ${
        active ? 'bg-indigo-500/15 text-fg' : 'text-fg-secondary hover:bg-state-soft hover:text-fg'
      }`}
    >
      <span className="min-w-0 flex-1 truncate" title={label}>
        {label}
        {hint && <span className="ml-2 text-meta text-fg-disabled">{hint}</span>}
      </span>
      {newCount > 0 && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" title={`${newCount} 条新的`} />}
      <span className="shrink-0 text-meta tabular-nums text-fg-tertiary">{count || ''}</span>
    </button>
  );
}

/** 列表上方：当前筛到的作用域说明 + 「清空」（已删除连接 / 已不存在分组尤其需要）。 */
function FilterHeader({ manager }: { manager: MemoryManager }) {
  const { filter, directory, selectedEntry } = manager;
  let text: string | null = null;
  let clearable: ScopeEntry[] = [];
  if (filter.kind === 'orphan-hosts') {
    text = '这些机器的连接已经删掉了，记忆还留着。确认用不上就清掉。';
    clearable = directory.orphanHosts;
  } else if (filter.kind === 'orphan-groups') {
    text = '这些分组已经不存在了（改名或拆散）。还有用的可以编辑改到别的作用域，没用的清掉。';
    clearable = directory.orphanGroups;
  } else if (selectedEntry && selectedEntry.count > 0) {
    clearable = [selectedEntry];
  }
  if (!text && clearable.length === 0) return null;
  return (
    <div className="flex items-center justify-between gap-3 text-meta text-fg-tertiary">
      <span className="min-w-0">{text}</span>
      {clearable.length === 1 && (
        <button
          type="button"
          onClick={() => void manager.clearScope(clearable[0])}
          className="shrink-0 rounded-md px-2 py-0.5 text-fg-secondary hover:bg-red-500/10 hover:text-red-300 transition"
        >
          清空 {clearable[0].label}
        </button>
      )}
    </div>
  );
}

function EmptyList({ manager }: { manager: MemoryManager }) {
  if (manager.query.trim()) {
    return (
      <div className="py-10 text-center">
        <SearchX size={24} strokeWidth={1.5} className="mx-auto mb-2 text-fg-tertiary" />
        <p className="text-body text-fg-secondary">没有匹配「{manager.query.trim()}」的记忆</p>
      </div>
    );
  }
  return (
    <div className="py-10 text-center text-body leading-relaxed text-fg-secondary">
      <Brain size={24} strokeWidth={1.5} className="mx-auto mb-2 text-fg-tertiary" />
      这里还没有记忆。
      <br />
      和 Agent 聊的时候它会记下值得长期记住的东西；也可以点「新增」手动写，或者让上面的整理助手从以前的会话里整理。
    </div>
  );
}

function ItemRow({ item, manager, onEdit }: { item: MemoryItem; manager: MemoryManager; onEdit: () => void }) {
  const connections = useConnectionStore((s) => s.connections);
  const showScope = manager.filter.kind !== 'scope';
  return (
    <li className="group flex min-w-0 gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          {item.pinned && <Pin className="h-3 w-3 shrink-0 text-indigo-400" aria-label="置顶" />}
          <span className="min-w-0 truncate text-body font-medium text-fg" title={item.title}>{item.title}</span>
          <span className="shrink-0 rounded bg-surface-raised px-2 py-px text-caption text-fg-secondary">{KIND_LABELS[item.kind]}</span>
          {item.isNew && <span className="shrink-0 rounded bg-indigo-500/20 px-2 py-px text-caption text-indigo-300">新</span>}
        </div>
        <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-meta leading-relaxed text-fg-secondary">{item.content}</p>
        <div className="mt-1 text-caption text-fg-disabled">
          {showScope && <>{scopeLabel(scopeOf(item), connections)} · </>}
          {SOURCE_LABELS[item.source]}记的 · {relativeTime(item.updatedAt)}
        </div>
      </div>
      <div className="flex shrink-0 items-start gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <RowAction onClick={() => void manager.togglePin(item)}>{item.pinned ? '取消置顶' : '置顶'}</RowAction>
        <RowAction onClick={onEdit}>编辑</RowAction>
        <RowAction danger onClick={() => void manager.remove(item)}>删除</RowAction>
      </div>
    </li>
  );
}

function RowAction({ children, onClick, danger = false }: { children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-2 py-1 text-meta transition ${
        danger ? 'text-fg-secondary hover:bg-red-500/10 hover:text-red-300' : 'text-fg-secondary hover:bg-state-soft hover:text-fg'
      }`}
    >
      {children}
    </button>
  );
}
