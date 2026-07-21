import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import type {
  QuickCommand,
  QuickCommandInput,
  QuickCommandScope,
} from '@/lib/types';
import * as tauri from '@/lib/tauri';
import { useConnectionStore } from '@/stores/connectionStore';
import { getErrorMessage } from '@/lib/errors';
import MobileSheet from '../ui/MobileSheet';

interface FormState {
  id?: string;
  scope: QuickCommandScope;
  /** Saved-connection id when scope === 'session' (same key desktop passes as configId). */
  sessionKey: string | null;
  name: string;
  commandsText: string;
  intervalMs: number;
}

const EMPTY_FORM: FormState = {
  scope: 'global',
  sessionKey: null,
  name: '',
  commandsText: '',
  intervalMs: 300,
};

function parseCommands(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Load every quick command visible to management: the backend
 * `quick_command_list(null)` only returns global commands, so we also query
 * each saved connection's key and merge by id (global entries repeat in each
 * result). Session commands whose connection was deleted stay invisible —
 * same as the desktop panel.
 */
async function loadAllCommands(
  connectionIds: readonly string[],
): Promise<QuickCommand[]> {
  const results = await Promise.all([
    tauri.quickCommandList(null),
    ...connectionIds.map((id) => tauri.quickCommandList(id)),
  ]);
  const byId = new Map<string, QuickCommand>();
  for (const list of results) {
    for (const cmd of list) {
      byId.set(cmd.id, cmd);
    }
  }
  return Array.from(byId.values());
}

const inputClass =
  'w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-indigo-500';

/**
 * Quick command management for mobile: list / create / edit / delete for both
 * global and per-connection commands. The sessionKey of a per-connection
 * command is the SavedConnection id — identical to what desktop terminals
 * pass as `activeSession.configId`, so commands created here show up in the
 * terminal quick bar of that connection.
 */
export function MobileQuickCommandSection() {
  const connections = useConnectionStore((s) => s.connections);
  const fetchConnections = useConnectionStore((s) => s.fetchConnections);

  const [commands, setCommands] = useState<QuickCommand[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<QuickCommand | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void fetchConnections();
  }, [fetchConnections]);

  const connectionIds = useMemo(
    () => connections.map((c) => c.id),
    [connections],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setCommands(await loadAllCommands(connectionIds));
    } catch (err) {
      setLoadError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [connectionIds]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const connectionName = useCallback(
    (sessionKey: string | null | undefined) => {
      if (!sessionKey) return null;
      return connections.find((c) => c.id === sessionKey)?.name ?? null;
    },
    [connections],
  );

  const handleSubmit = async () => {
    if (!form) return;
    const lines = parseCommands(form.commandsText);
    if (!form.name.trim()) {
      setMessage('名称不能为空');
      return;
    }
    if (lines.length === 0) {
      setMessage('至少需要一条命令');
      return;
    }
    if (form.scope === 'session' && !form.sessionKey) {
      setMessage('请选择该命令所属的连接');
      return;
    }
    const payload: QuickCommandInput = {
      scope: form.scope,
      sessionKey: form.scope === 'session' ? form.sessionKey : null,
      name: form.name.trim(),
      commands: lines,
      intervalMs: form.intervalMs,
    };
    setSaving(true);
    setMessage(null);
    try {
      if (form.id) {
        await tauri.quickCommandUpdate(form.id, payload);
      } else {
        await tauri.quickCommandAdd(payload);
      }
      setForm(null);
      await reload();
    } catch (err) {
      setMessage(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await tauri.quickCommandDelete(deleteTarget.id);
      setDeleteTarget(null);
      await reload();
    } catch (err) {
      setMessage(getErrorMessage(err));
      setDeleteTarget(null);
    }
  };

  const displayError = message ?? loadError;

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => {
          setMessage(null);
          setForm(EMPTY_FORM);
        }}
        className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-700 px-3 py-3 text-sm text-zinc-300 transition-colors duration-100 active:scale-[0.99] active:bg-zinc-900"
      >
        <Plus className="h-4 w-4" />
        新建快捷命令
      </button>

      {displayError && (
        <div className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {displayError}
        </div>
      )}

      {loading && commands.length === 0 && (
        <p className="py-8 text-center text-sm text-zinc-500">加载中…</p>
      )}

      {!loading && commands.length === 0 && !displayError && (
        <p className="py-8 text-center text-sm text-zinc-500">
          暂无快捷命令，新建后会显示在终端输入栏上方。
        </p>
      )}

      {commands.map((cmd) => (
        <div
          key={cmd.id}
          className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-3"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-zinc-100">
                {cmd.name}
              </span>
              <span className="flex-shrink-0 rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">
                {cmd.scope === 'global'
                  ? '全局'
                  : (connectionName(cmd.sessionKey) ?? '指定连接')}
              </span>
            </div>
            <div className="mt-0.5 truncate font-mono text-xs text-zinc-500">
              {cmd.commands.join(' ; ')}
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setMessage(null);
              setForm({
                id: cmd.id,
                scope: cmd.scope,
                sessionKey: cmd.sessionKey ?? null,
                name: cmd.name,
                commandsText: cmd.commands.join('\n'),
                intervalMs: cmd.intervalMs,
              });
            }}
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-zinc-400 active:bg-zinc-800"
            aria-label={`编辑 ${cmd.name}`}
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setDeleteTarget(cmd)}
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-zinc-500 active:bg-zinc-800 active:text-red-400"
            aria-label={`删除 ${cmd.name}`}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}

      {/* Create / edit sheet */}
      <MobileSheet
        open={form != null}
        onClose={() => setForm(null)}
        title={form?.id ? '编辑快捷命令' : '新建快捷命令'}
        footer={
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setForm(null)}
              className="flex-1 rounded-xl bg-zinc-800 px-4 py-3 text-sm text-zinc-300 active:bg-zinc-700"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={saving}
              className="flex-1 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-medium text-white active:bg-indigo-500 disabled:opacity-40"
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        }
      >
        {form && (
          <div className="space-y-3 px-4 pb-3">
            {message && (
              <div className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-xs text-red-300">
                {message}
              </div>
            )}
            <div>
              <label className="mb-1 block text-xs text-zinc-400">名称</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="例如：部署"
                className={inputClass}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-400">
                作用域
              </label>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    { value: 'global', label: '全局', desc: '所有连接可用' },
                    {
                      value: 'session',
                      label: '指定连接',
                      desc: '仅所选连接可见',
                    },
                  ] as {
                    value: QuickCommandScope;
                    label: string;
                    desc: string;
                  }[]
                ).map((s) => {
                  const active = form.scope === s.value;
                  return (
                    <button
                      key={s.value}
                      type="button"
                      onClick={() => setForm({ ...form, scope: s.value })}
                      className={`rounded-xl border px-3 py-2.5 text-left transition-colors duration-100 active:scale-[0.99] ${
                        active
                          ? 'border-indigo-500 bg-indigo-500/10'
                          : 'border-zinc-700 bg-zinc-800/60'
                      }`}
                    >
                      <div
                        className={`text-sm font-medium ${
                          active ? 'text-indigo-200' : 'text-zinc-300'
                        }`}
                      >
                        {s.label}
                      </div>
                      <div className="mt-0.5 text-[11px] text-zinc-500">
                        {s.desc}
                      </div>
                    </button>
                  );
                })}
              </div>
              {form.scope === 'session' &&
                (connections.length === 0 ? (
                  <p className="mt-2 text-xs text-zinc-500">
                    暂无已保存的连接，请先在连接页保存一个连接。
                  </p>
                ) : (
                  <select
                    value={form.sessionKey ?? ''}
                    onChange={(e) =>
                      setForm({ ...form, sessionKey: e.target.value || null })
                    }
                    className={`mt-2 ${inputClass}`}
                  >
                    <option value="" disabled>
                      选择连接…
                    </option>
                    {connections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}（{c.username}@{c.host}）
                      </option>
                    ))}
                    {/* Keep an orphaned key selectable so editing doesn't lose it. */}
                    {form.sessionKey &&
                      !connections.some((c) => c.id === form.sessionKey) && (
                        <option value={form.sessionKey}>
                          已删除的连接（{form.sessionKey}）
                        </option>
                      )}
                  </select>
                ))}
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-400">
                命令（每行一条，按顺序执行）
              </label>
              <textarea
                value={form.commandsText}
                onChange={(e) =>
                  setForm({ ...form, commandsText: e.target.value })
                }
                rows={5}
                placeholder={'git pull\npnpm build\npm2 restart app'}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className={`${inputClass} resize-none font-mono`}
              />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="text-xs text-zinc-400">多条命令间隔</label>
                <span className="font-mono text-xs text-indigo-300">
                  {form.intervalMs}ms
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={3000}
                step={100}
                value={form.intervalMs}
                onChange={(e) =>
                  setForm({ ...form, intervalMs: Number(e.target.value) })
                }
                className="h-2 w-full cursor-pointer appearance-none rounded-full bg-zinc-700 accent-indigo-500"
              />
            </div>
          </div>
        )}
      </MobileSheet>

      {/* Delete confirm sheet */}
      <MobileSheet
        open={deleteTarget != null}
        onClose={() => setDeleteTarget(null)}
        title="确认删除"
      >
        <div className="flex flex-col gap-2 px-4 pb-4">
          <p className="pb-1 text-sm text-zinc-400">
            删除快捷命令「{deleteTarget?.name}」？此操作不可撤销。
          </p>
          <button
            type="button"
            onClick={() => void handleDelete()}
            className="rounded-xl bg-red-600 px-4 py-3 text-sm font-medium text-white active:bg-red-500"
          >
            删除
          </button>
          <button
            type="button"
            onClick={() => setDeleteTarget(null)}
            className="rounded-xl px-4 py-3 text-sm text-zinc-400 active:bg-zinc-800"
          >
            取消
          </button>
        </div>
      </MobileSheet>
    </div>
  );
}
