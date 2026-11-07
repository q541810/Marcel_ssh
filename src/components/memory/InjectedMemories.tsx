import { useMemo, useState } from 'react';
import { KIND_LABELS, scopeId, scopeLabel, type InjectedMemories, type ScopeRef } from '@/lib/memory';
import { openMemorySettings } from '@/lib/memoryNav';
import { useConnectionStore } from '@/stores/connectionStore';
import { GROUP_PREVIEW, groupInjected, type InjectedGroup } from './injectedGroups';

interface ListProps {
  data: InjectedMemories | null;
  error: string | null;
  /** 「管理记忆」跳到这台机器的作用域。 */
  focus?: ScopeRef;
  mobile?: boolean;
  onNavigate?: () => void;
}

/**
 * 弹层 / 底部面板里的列表：按作用域分组，只列标题，点「管理记忆」去管理页。
 *
 * 列表区自己滚动，「管理记忆」钉在底部——记忆多了入口也不会被挤到几屏之外。
 * 桌面弹层的高度由外层限定（本组件填满剩余空间）；手机底部面板没有固定高度，所以这里自己限高。
 */
export function InjectedMemoryList({ data, error, focus, mobile = false, onNavigate }: ListProps) {
  const connections = useConnectionStore((s) => s.connections);
  const groups = useMemo(() => groupInjected(data), [data]);

  if (error) return <p className="text-red-400">{error}</p>;
  if (!data) return <p className="text-fg-tertiary">读取中…</p>;
  if (!data.enabled) {
    return (
      <div className="flex flex-col gap-2">
        <p className="leading-relaxed text-fg-secondary">长期记忆已关闭，对话不会带上任何记忆，Agent 也不会再记新的。</p>
        <ManageLink focus={focus} mobile={mobile} onNavigate={onNavigate} label="去打开" />
      </div>
    );
  }

  const titleOnly = groups.some((g) => g.items.some((e) => e.carried === 'title'));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div
        className={`flex flex-col gap-3 overflow-y-auto overscroll-contain ${
          mobile ? 'max-h-[55dvh]' : 'min-h-0 flex-1 pr-1'
        }`}
      >
        <p className="leading-relaxed text-fg-tertiary">
          {data.frozen
            ? '这段对话开始时带给 Agent 的记忆。之后新记的从下一段对话起生效；你手动改的下一轮就生效。'
            : '下一轮（或新对话）起会带给 Agent 的记忆。'}
          {titleOnly && '标「仅标题」的，Agent 只看到标题，要细节得自己去查。'}
        </p>
        {groups.length === 0 ? (
          <p className="leading-relaxed text-fg-secondary">
            {data.frozen && data.pending > 0
              ? '这段对话开始时还没有记忆，所以一条都没带。'
              : data.elsewhere > 0
                ? '这台机器（和它所在的分组）还没有记忆。'
                : '还没有记忆。Agent 会在对话中记下值得长期记住的东西，你也可以在记忆管理里手动添加。'}
          </p>
        ) : (
          groups.map((g) => (
            <ScopeGroup key={scopeId(g.ref)} group={g} label={scopeLabel(g.ref, connections)} mobile={mobile} />
          ))
        )}
        {data.pending > 0 && (
          <p className="leading-relaxed text-fg-tertiary">
            另有 {data.pending} 条是这段对话开始后才记下的，下一段对话起会带上（压缩上下文后也会刷新）。
          </p>
        )}
        {data.leftOut > 0 && (
          <p className="leading-relaxed text-fg-tertiary">
            另有 {data.leftOut} 条太多放不进提示词，没有带入；Agent 需要时能搜到。
          </p>
        )}
        {data.elsewhere > 0 && (
          <p className="leading-relaxed text-fg-tertiary">
            记忆管理里另有 {data.elsewhere} 条属于别的机器或分组，不会带进这段对话。
          </p>
        )}
        {data.removedSince > 0 && (
          <p className="text-fg-tertiary">另有 {data.removedSince} 条已被删除，下一轮起不再带。</p>
        )}
      </div>
      <ManageLink focus={focus} mobile={mobile} onNavigate={onNavigate} label="管理记忆" />
    </div>
  );
}

function ScopeGroup({ group, label, mobile }: { group: InjectedGroup; label: string; mobile: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const hidden = Math.max(0, group.items.length - GROUP_PREVIEW);
  const shown = expanded || hidden === 0 ? group.items : group.items.slice(0, GROUP_PREVIEW);
  return (
    <div className="flex flex-col gap-1">
      <div className="font-medium text-fg-secondary">
        {label}
        <span className="ml-2 font-normal text-fg-tertiary">{group.items.length}</span>
      </div>
      <ul className="flex flex-col gap-1">
        {shown.map(({ item: m, carried }) => (
          <li key={m.id} className="flex min-w-0 items-baseline gap-2" title={m.content}>
            <span className="shrink-0 text-fg-disabled">{KIND_LABELS[m.kind]}</span>
            <span className="min-w-0 truncate text-fg-secondary">{m.title}</span>
            {m.pinned && <span className="shrink-0 text-indigo-400/80">置顶</span>}
            {carried === 'title' && <span className="shrink-0 text-fg-disabled">仅标题</span>}
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className={`self-start rounded-md text-fg-tertiary transition hover:text-fg-secondary ${
            mobile ? '-ml-1 px-1 py-1' : '-ml-1 px-1 py-0.5'
          }`}
        >
          {expanded ? '收起' : `还有 ${hidden} 条`}
        </button>
      )}
    </div>
  );
}

function ManageLink({
  focus, mobile, onNavigate, label,
}: { focus?: ScopeRef; mobile: boolean; onNavigate?: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        onNavigate?.();
        openMemorySettings(focus);
      }}
      className={`self-start rounded-lg text-indigo-300 hover:bg-indigo-500/10 transition ${
        mobile ? '-ml-2 px-2 py-2' : '-ml-2 px-2 py-0.5'
      }`}
    >
      {label} →
    </button>
  );
}
