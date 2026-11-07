import { useState, type ReactNode } from 'react';
import { ChevronDown, Pin, Plus, Search } from 'lucide-react';
import Toggle from '@/components/ui/Toggle';
import MemoryEditDialog from '@/components/memory/MemoryEditDialog';
import MemoryAssistantLauncher from '@/components/memory/MemoryAssistantLauncher';
import { filterKey, useMemoryManager, type MemoryManager } from '@/components/memory/useMemoryManager';
import { useSettingsActions } from '@/components/settings/SettingsActionsContext';
import { emptyRegistry, modelFullLabel } from '@/lib/llmRegistry';
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
import MobileSheet from '../ui/MobileSheet';
import { MobileSettingRow } from './MobileSettingRow';
import { MobileModelPickerSheet } from './MobileModelSection';

/** 手机端「记忆」：开关与记忆模型、整理助手、记忆管理（与桌面 `MemorySection` 同一套逻辑）。 */
export function MobileMemorySection() {
  const { settings, update } = useSettingsActions();
  const ms: MemorySettings = settings.memorySettings ?? DEFAULT_MEMORY_SETTINGS;
  const registry: LlmRegistry = settings.llmRegistry ?? emptyRegistry();
  const [modelPicker, setModelPicker] = useState(false);
  const manager = useMemoryManager();
  const setMs = (patch: Partial<MemorySettings>) => update({ memorySettings: { ...ms, ...patch } });
  const memoryModelId = registry.slots.memoryModelId ?? '';

  return (
    <div className="flex flex-col gap-3">
      <MobileSettingRow
        label="启用长期记忆"
        description="关闭后对话不再带上记忆，Agent 也不能记新的；已有的记忆保留"
        trailing={<Toggle checked={ms.enabled} onChange={(v) => setMs({ enabled: v })} />}
      />
      <MobileSettingRow
        label="后台复盘"
        description="对话停下 10 分钟、连接断开或上下文压缩时，回顾刚才的对话把值得记住的记下来（在对话里列出，可撤销）。默认关闭：每次是一次额外的模型调用，计入该会话的用量"
        trailing={<Toggle checked={ms.autoReflect} disabled={!ms.enabled} onChange={(v) => setMs({ autoReflect: v })} />}
      />
      <MobileSettingRow
        label="记忆模型"
        description="后台复盘用的模型，留空 = 跟随会话正在用的模型。用便宜的小模型就够"
      >
        <button
          type="button"
          onClick={() => setModelPicker(true)}
          className="mt-2 flex w-full items-center justify-between gap-2 rounded-lg border border-edge bg-fill px-3 py-2.5 text-body text-fg active:bg-state-mid"
        >
          <span className="truncate">{memoryModelId ? modelFullLabel(registry, memoryModelId) : '跟随会话模型'}</span>
          <ChevronDown className="h-4 w-4 flex-shrink-0 text-fg-tertiary" />
        </button>
      </MobileSettingRow>

      <SectionTitle title="整理助手" />
      <div className="rounded-xl border border-edge-subtle bg-surface px-3 py-3">
        <MemoryAssistantLauncher focus={manager.focus} mobile />
      </div>

      <MobileManage manager={manager} />

      <MobileModelPickerSheet
        open={modelPicker}
        onClose={() => setModelPicker(false)}
        title="选择记忆模型"
        registry={registry}
        value={memoryModelId}
        allowEmpty
        emptyLabel="跟随会话模型"
        onChange={(modelId) => update({ llmRegistry: { ...registry, slots: { ...registry.slots, memoryModelId: modelId } } })}
      />
    </div>
  );
}

function SectionTitle({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="mt-3 flex items-center justify-between px-1">
      <h2 className="text-meta font-medium text-fg-tertiary">{title}</h2>
      {action}
    </div>
  );
}

function MobileManage({ manager }: { manager: MemoryManager }) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<MemoryItem | null>(null);
  const [actionsFor, setActionsFor] = useState<MemoryItem | null>(null);
  const { directory, filter, setFilter } = manager;

  const chips: { key: string; label: string; count: number; fresh: boolean; filter: MemoryFilter }[] = [
    { key: 'all', label: '全部', count: directory.total, fresh: directory.totalNew > 0, filter: { kind: 'all' } },
    { key: 'user', label: '全局', count: directory.global.count, fresh: directory.global.newCount > 0, filter: { kind: 'scope', ref: directory.global.ref } },
    ...directory.groups.map((e) => chipFor(e, `分组 ${e.ref.key}`)),
    ...directory.hosts.map((e) => chipFor(e, e.label)),
    ...(directory.orphanHosts.length > 0
      ? [{ key: 'orphan-hosts', label: '已删除的连接', count: sum(directory.orphanHosts), fresh: false, filter: { kind: 'orphan-hosts' } as MemoryFilter }]
      : []),
    ...(directory.orphanGroups.length > 0
      ? [{ key: 'orphan-groups', label: '已不存在的分组', count: sum(directory.orphanGroups), fresh: false, filter: { kind: 'orphan-groups' } as MemoryFilter }]
      : []),
  ];
  const activeKey = filterKey(filter);

  return (
    <>
      <SectionTitle
        title="记忆管理"
        action={
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="-mr-1 flex items-center gap-1 rounded-lg min-h-11 px-2 py-1.5 text-body text-indigo-300 active:bg-state-soft"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            新增
          </button>
        }
      />
      <div className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-1 [scrollbar-width:none]" role="tablist" aria-label="记忆作用域">
        {chips.map((c) => {
          const active = filterKey(c.filter) === activeKey;
          return (
            <button
              key={c.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setFilter(c.filter)}
              className={`flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-meta pressable ${
                active ? 'border-indigo-500/60 bg-indigo-500/15 text-fg' : 'border-edge-subtle bg-surface text-fg-secondary'
              }`}
            >
              {c.label}
              {c.count > 0 && <span className="tabular-nums text-fg-tertiary">{c.count}</span>}
              {c.fresh && <span className="h-1.5 w-1.5 rounded-full bg-indigo-400" aria-label="有新的" />}
            </button>
          );
        })}
      </div>

      <label className="flex items-center gap-2 rounded-xl border border-edge-subtle bg-surface px-3 py-2.5 focus-within:border-indigo-500/70">
        <Search className="h-4 w-4 shrink-0 text-fg-tertiary" aria-hidden />
        <input
          value={manager.query}
          onChange={(e) => manager.setQuery(e.target.value)}
          placeholder="搜索标题或内容"
          className="min-w-0 flex-1 bg-transparent text-body text-fg placeholder:text-fg-tertiary focus:outline-none"
        />
      </label>

      <MobileFilterHeader manager={manager} />

      {manager.undo && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-edge bg-surface-raised px-3 py-2 text-meta">
          <span className="min-w-0 truncate text-fg-secondary">{manager.undo.text}</span>
          <button type="button" onClick={() => void manager.undoLast()}
            className="shrink-0 rounded-lg px-2.5 py-1.5 font-medium text-indigo-300 active:bg-indigo-500/10">
            撤销
          </button>
        </div>
      )}
      {manager.actionError && <p className="px-1 text-meta text-red-400">{manager.actionError}</p>}

      {!manager.loaded ? (
        <p className="py-8 text-center text-body text-fg-tertiary">{manager.loadError ?? '读取中…'}</p>
      ) : manager.items.length === 0 ? (
        <p className="px-2 py-8 text-center text-body leading-relaxed text-fg-tertiary">
          {manager.query.trim()
            ? `没有匹配「${manager.query.trim()}」的记忆`
            : '这里还没有记忆。和 Agent 聊的时候它会记下值得记住的东西；也可以点「新增」手动写，或者让整理助手从以前的会话里整理。'}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {manager.items.map((m) => (
            <MobileItem key={m.id} item={m} showScope={filter.kind !== 'scope'} onOpen={() => setActionsFor(m)} />
          ))}
        </ul>
      )}

      <MobileSheet open={!!actionsFor} onClose={() => setActionsFor(null)} title={actionsFor?.title}>
        {actionsFor && (
          <div className="flex flex-col gap-1 px-4 pb-4">
            <p className="whitespace-pre-wrap break-words pb-2 text-body leading-relaxed text-fg-secondary">{actionsFor.content}</p>
            <SheetAction onClick={() => { const m = actionsFor; setActionsFor(null); setEditing(m); }}>编辑</SheetAction>
            <SheetAction onClick={() => { const m = actionsFor; setActionsFor(null); void manager.togglePin(m); }}>
              {actionsFor.pinned ? '取消置顶' : '置顶'}
            </SheetAction>
            <SheetAction danger onClick={() => { const m = actionsFor; setActionsFor(null); void manager.remove(m); }}>
              删除
            </SheetAction>
          </div>
        )}
      </MobileSheet>
      <MemoryEditDialog open={!!editing} item={editing} onClose={() => setEditing(null)} />
      <MemoryEditDialog open={creating} item={null} defaultScope={manager.focus ?? undefined} onClose={() => setCreating(false)} />
    </>
  );
}

function chipFor(e: ScopeEntry, label: string) {
  return { key: `${e.ref.scope}:${e.ref.key}`, label, count: e.count, fresh: e.newCount > 0, filter: { kind: 'scope', ref: e.ref } as MemoryFilter };
}

function sum(entries: ScopeEntry[]) {
  return entries.reduce((n, e) => n + e.count, 0);
}

function MobileFilterHeader({ manager }: { manager: MemoryManager }) {
  const { filter, directory, selectedEntry } = manager;
  let text: string | null = null;
  let clearable: ScopeEntry | null = null;
  if (filter.kind === 'orphan-hosts') {
    text = '这些机器的连接已经删掉了，记忆还留着。确认用不上就删掉。';
    if (directory.orphanHosts.length === 1) clearable = directory.orphanHosts[0];
  } else if (filter.kind === 'orphan-groups') {
    text = '这些分组已经不存在了。还有用的可以编辑改到别的作用域，没用的删掉。';
    if (directory.orphanGroups.length === 1) clearable = directory.orphanGroups[0];
  } else if (selectedEntry && selectedEntry.count > 0) {
    clearable = selectedEntry;
  }
  if (!text && !clearable) return null;
  return (
    <div className="flex items-center justify-between gap-3 px-1 text-meta text-fg-tertiary">
      <span className="min-w-0">{text}</span>
      {clearable && (
        <button
          type="button"
          onClick={() => void manager.clearScope(clearable!)}
          className="shrink-0 rounded-lg px-2.5 py-1.5 text-fg-secondary active:bg-red-500/10 active:text-red-300"
        >
          清空 {clearable.label}
        </button>
      )}
    </div>
  );
}

function MobileItem({ item, showScope, onOpen }: { item: MemoryItem; showScope: boolean; onOpen: () => void }) {
  const connections = useConnectionStore((s) => s.connections);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="w-full rounded-xl border border-edge-subtle bg-surface px-3 py-3 text-left pressable"
      >
        <div className="flex min-w-0 items-center gap-2">
          {item.pinned && <Pin className="h-3 w-3 shrink-0 text-indigo-400" aria-label="置顶" />}
          <span className="min-w-0 flex-1 truncate text-body font-medium text-fg">{item.title}</span>
          {item.isNew && <span className="shrink-0 rounded bg-indigo-500/20 px-1.5 py-px text-caption text-indigo-300">新</span>}
          <span className="shrink-0 rounded bg-surface-raised px-1.5 py-px text-caption text-fg-secondary">{KIND_LABELS[item.kind]}</span>
        </div>
        <p className="mt-1 line-clamp-2 break-words text-meta leading-relaxed text-fg-secondary">{item.content}</p>
        <div className="mt-1 text-caption text-fg-disabled">
          {showScope && <>{scopeLabel(scopeOf(item), connections)} · </>}
          {SOURCE_LABELS[item.source]}记的 · {relativeTime(item.updatedAt)}
        </div>
      </button>
    </li>
  );
}

function SheetAction({ children, onClick, danger = false }: { children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl px-4 py-3 text-left text-body active:bg-state-soft ${danger ? 'text-red-400' : 'text-fg'}`}
    >
      {children}
    </button>
  );
}
