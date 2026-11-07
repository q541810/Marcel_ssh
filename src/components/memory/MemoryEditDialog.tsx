import { useEffect, useMemo, useRef, useState } from 'react';
import Modal from '@/components/ui/Modal';
import Select, { type SelectSource } from '@/components/ui/Select';
import SegmentedControl from '@/components/ui/SegmentedControl';
import Toggle from '@/components/ui/Toggle';
import MobileSheet from '@/mobile/ui/MobileSheet';
import { MobileChoiceGroup } from '@/mobile/ui/MobileChoiceGroup';
import MobileSelect from '@/mobile/ui/MobileSelect';
import { collectPlatformHints, isMobilePlatform } from '@/platform';
import { getErrorMessage } from '@/lib/errors';
import {
  GLOBAL_SCOPE,
  KIND_HINTS,
  KIND_LABELS,
  KIND_ORDER,
  MEMORY_CONTENT_MAX,
  MEMORY_TITLE_MAX,
  sameScope,
  scopeId,
  scopeLabel,
  scopeOf,
  type MemoryItem,
  type MemoryKind,
  type MemoryWriteOp,
  type ScopeRef,
} from '@/lib/memory';
import { useConnectionStore } from '@/stores/connectionStore';
import { useMemoryStore } from '@/stores/memoryStore';

interface Props {
  open: boolean;
  onClose: () => void;
  /** 要改的那条；`null` = 新增。 */
  item: MemoryItem | null;
  /** 新增时预选的作用域（管理页当前筛选的那个）。 */
  defaultScope?: ScopeRef;
  /** 保存成功（返回写入后的那条）。 */
  onSaved?: (item: MemoryItem | null) => void;
}

/** 作用域选项：全局 → 各分组 → 各连接；当前值指向已删除的连接 / 分组时补一项，免得看起来像没选。 */
function useScopeOptions(current: ScopeRef) {
  const connections = useConnectionStore((s) => s.connections);
  return useMemo(() => {
    const groups: string[] = [];
    for (const c of connections) {
      const g = c.group?.trim();
      if (g && !groups.includes(g)) groups.push(g);
    }
    const flat: { ref: ScopeRef; label: string; section: string }[] = [
      { ref: GLOBAL_SCOPE, label: '全局（关于你本人，每台机器都适用）', section: '' },
      ...groups.map((g) => ({ ref: { scope: 'group' as const, key: g }, label: `分组「${g}」`, section: '分组' })),
      ...connections.map((c) => ({ ref: { scope: 'host' as const, key: c.id }, label: c.name, section: '机器' })),
    ];
    if (!flat.some((o) => sameScope(o.ref, current))) {
      flat.push({ ref: current, label: scopeLabel(current, connections), section: '其他' });
    }
    return flat;
  }, [connections, current]);
}

export default function MemoryEditDialog({ open, onClose, item, defaultScope, onSaved }: Props) {
  const mobile = useMemo(() => isMobilePlatform(collectPlatformHints()), []);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [kind, setKind] = useState<MemoryKind>('fact');
  const [scope, setScope] = useState<ScopeRef>(GLOBAL_SCOPE);
  const [pinned, setPinned] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(item?.title ?? '');
    setContent(item?.content ?? '');
    setKind(item?.kind ?? 'fact');
    setScope(item ? scopeOf(item) : (defaultScope ?? GLOBAL_SCOPE));
    setPinned(item?.pinned ?? false);
    setError(null);
    setSaving(false);
    // 桌面打开即可输入；手机不抢焦点（会弹键盘挡住表单）。
    if (!mobile) requestAnimationFrame(() => titleRef.current?.focus());
  }, [open, item, defaultScope, mobile]);

  const scopeOptions = useScopeOptions(scope);
  const titleLen = [...title.trim()].length;
  const contentLen = [...content.trim()].length;
  const invalid =
    titleLen === 0 ? '标题不能为空'
    : titleLen > MEMORY_TITLE_MAX ? `标题最多 ${MEMORY_TITLE_MAX} 字`
    : contentLen === 0 ? '内容不能为空'
    : contentLen > MEMORY_CONTENT_MAX ? `内容最多 ${MEMORY_CONTENT_MAX} 字`
    : null;

  const save = async () => {
    if (invalid || saving) return;
    setSaving(true);
    setError(null);
    let op: MemoryWriteOp;
    if (item) {
      op = {
        op: 'update',
        id: item.id,
        expectedVersion: item.version,
        title: title.trim(),
        content: content.trim(),
        kind,
        pinned,
        ...(sameScope(scope, scopeOf(item)) ? {} : { scope }),
      };
    } else {
      op = { op: 'add', scope: scope.scope, scopeKey: scope.key, kind, title: title.trim(), content: content.trim(), pinned };
    }
    try {
      const [rec] = await useMemoryStore.getState().apply([op]);
      onSaved?.(rec?.after ?? null);
      onClose();
    } catch (e) {
      setError(getErrorMessage(e));
      setSaving(false);
    }
  };

  const counter = (n: number, max: number) => (
    <span className={`tabular-nums ${n > max ? 'text-red-400' : 'text-fg-tertiary'}`}>{n}/{max}</span>
  );

  const fieldClass =
    'w-full rounded-lg bg-surface border border-edge px-3 py-2 text-body text-fg placeholder:text-fg-tertiary focus:outline-none focus:border-indigo-500 transition-colors';

  const form = (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-2">
        <span className="flex items-baseline justify-between text-meta text-fg-secondary">
          <span>标题</span>
          {counter(titleLen, MEMORY_TITLE_MAX)}
        </span>
        <input
          ref={titleRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="一眼能认出它的短语，如「nginx 配置位置」"
          className={fieldClass}
        />
      </label>
      <label className="flex flex-col gap-2">
        <span className="flex items-baseline justify-between text-meta text-fg-secondary">
          <span>内容</span>
          {counter(contentLen, MEMORY_CONTENT_MAX)}
        </span>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={mobile ? 5 : 4}
          placeholder="写结论，如「/opt/nginx/conf/nginx.conf，改完 nginx -t 再 reload」"
          className={`${fieldClass} resize-none leading-relaxed`}
        />
      </label>
      <div className="flex flex-col gap-2">
        <span className="text-meta text-fg-secondary">种类</span>
        {mobile ? (
          <MobileChoiceGroup
            ariaLabel="种类"
            value={kind}
            onChange={setKind}
            options={KIND_ORDER.map((k) => ({ value: k, label: KIND_LABELS[k] }))}
          />
        ) : (
          <SegmentedControl
            ariaLabel="种类"
            value={kind}
            onChange={setKind}
            options={KIND_ORDER.map((k) => ({ value: k, label: KIND_LABELS[k], title: KIND_HINTS[k] }))}
          />
        )}
        <span className="text-meta text-fg-tertiary">{KIND_HINTS[kind]}</span>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-meta text-fg-secondary">谁能用到</span>
        {mobile ? (
          <MobileSelect
            ariaLabel="谁能用到"
            value={scopeId(scope)}
            onChange={(id) => {
              const hit = scopeOptions.find((o) => scopeId(o.ref) === id);
              if (hit) setScope(hit.ref);
            }}
            className={fieldClass}
            options={scopeOptions.map((o) => ({
              value: scopeId(o.ref),
              label: o.section ? `${o.section} · ${o.label}` : o.label,
            }))}
          />
        ) : (
          <Select
            value={scopeId(scope)}
            onChange={(v) => {
              const hit = scopeOptions.find((o) => scopeId(o.ref) === v);
              if (hit) setScope(hit.ref);
            }}
            options={groupScopeOptions(scopeOptions)}
            className="w-full"
          />
        )}
      </div>
      <div className="flex items-center justify-between">
        <div className="flex flex-col">
          <span className="text-body text-fg">置顶</span>
          <span className="text-meta text-fg-tertiary">记忆很多时，置顶的总会完整带给 Agent</span>
        </div>
        <Toggle checked={pinned} onChange={setPinned} />
      </div>
      {(error || (invalid && (titleLen > 0 || contentLen > 0))) && (
        <p className="text-meta text-red-400">{error ?? invalid}</p>
      )}
    </div>
  );

  const actions = (
    <div className="flex justify-end gap-2">
      <button
        type="button"
        onClick={onClose}
        className="rounded-lg px-4 py-2 text-body text-fg-secondary hover:bg-state-mid/60 transition"
      >
        取消
      </button>
      <button
        type="button"
        onClick={() => void save()}
        disabled={!!invalid || saving}
        className="rounded-lg bg-indigo-600 px-4 py-2 text-body font-medium text-white hover:bg-indigo-500 transition disabled:opacity-40"
      >
        {saving ? '保存中…' : '保存'}
      </button>
    </div>
  );

  const heading = item ? '编辑记忆' : '新增记忆';

  if (mobile) {
    return (
      <MobileSheet open={open} onClose={onClose} title={heading} footer={actions}>
        <div className="px-4 pb-4">{form}</div>
      </MobileSheet>
    );
  }
  return (
    <Modal open={open} onClose={onClose} title={heading}>
      <div className="flex flex-col gap-5 px-5 pt-4 pb-5">
        {form}
        {actions}
      </div>
    </Modal>
  );
}

function groupScopeOptions(flat: { ref: ScopeRef; label: string; section: string }[]): SelectSource {
  const out: SelectSource = [];
  const sections = new Map<string, { value: string; label: string }[]>();
  for (const o of flat) {
    const opt = { value: scopeId(o.ref), label: o.label };
    if (!o.section) {
      out.push(opt);
      continue;
    }
    const list = sections.get(o.section);
    if (list) list.push(opt);
    else sections.set(o.section, [opt]);
  }
  for (const [label, options] of sections) out.push({ label, options });
  return out;
}
