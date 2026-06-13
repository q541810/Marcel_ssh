import { useEffect, useMemo, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { QuickCommand, QuickCommandInput, QuickCommandScope } from '@/lib/types';
import { useQuickCommandStore } from '@/stores/quickCommandStore';
import { getErrorMessage } from '@/lib/errors';

interface QuickCommandPanelProps {
  sessionId: string;
  sessionKey?: string | null;
}

interface FormState {
  id?: string;
  scope: QuickCommandScope | '';
  name: string;
  commandsText: string;
  intervalMs: number;
}

type QuickCommandTab = 'all' | QuickCommandScope;

const emptyForm = (scope: QuickCommandScope | ''): FormState => ({
  scope,
  name: '',
  commandsText: '',
  intervalMs: 300,
});

function commandToForm(command: QuickCommand): FormState {
  return {
    id: command.id,
    scope: command.scope,
    name: command.name,
    commandsText: command.commands.join('\n'),
    intervalMs: command.intervalMs,
  };
}

function parseCommands(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export default function QuickCommandPanel({ sessionId, sessionKey }: QuickCommandPanelProps) {
  const [tab, setTab] = useState<QuickCommandTab>('all');
  const [form, setForm] = useState<FormState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const commands = useQuickCommandStore((s) => s.commands);
  const loading = useQuickCommandStore((s) => s.loading);
  const error = useQuickCommandStore((s) => s.error);
  const executingId = useQuickCommandStore((s) => s.executingId);
  const load = useQuickCommandStore((s) => s.load);
  const add = useQuickCommandStore((s) => s.add);
  const update = useQuickCommandStore((s) => s.update);
  const remove = useQuickCommandStore((s) => s.delete);
  const execute = useQuickCommandStore((s) => s.execute);

  useEffect(() => {
    load(sessionKey).catch((err) => setMessage(`加载失败：${getErrorMessage(err)}`));
  }, [sessionKey, load]);

  useEffect(() => {
    if (!sessionKey && tab === 'session') {
      setTab('all');
    }
  }, [sessionKey, tab]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setActiveMenuId(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [setActiveMenuId]);

  const visibleCommands = useMemo(() => {
    const scoped = tab === 'all' ? commands : commands.filter((c) => c.scope === tab);
    if (!search.trim()) return scoped;
    const q = search.toLowerCase();
    return scoped.filter((c) => c.name.toLowerCase().includes(q));
  }, [commands, tab, search]);

  const canUseSessionCommands = !!sessionKey;

  const handleNew = () => {
    const scope = tab === 'all' ? '' : tab;
    setForm(emptyForm(scope));
    setMessage(null);
  };

  const handleSubmit = async () => {
    if (!form) return;
    const commandLines = parseCommands(form.commandsText);
    if (!form.scope) {
      setMessage('请选择快捷指令作用域');
      return;
    }
    if (!form.name.trim()) {
      setMessage('名称不能为空');
      return;
    }
    if (commandLines.length === 0) {
      setMessage('至少需要一条命令');
      return;
    }
    if (form.scope === 'session' && !sessionKey) {
      setMessage('当前会话未绑定保存的连接配置，不能创建当前连接快捷指令');
      return;
    }

    const payload: QuickCommandInput = {
      scope: form.scope,
      sessionKey: form.scope === 'session' ? sessionKey ?? null : null,
      name: form.name.trim(),
      commands: commandLines,
      intervalMs: Math.max(0, Number(form.intervalMs) || 0),
    };

    try {
      if (form.id) {
        await update(form.id, payload);
      } else {
        await add(payload);
      }
      setForm(null);
      setTab(tab === 'all' ? 'all' : payload.scope);
      setMessage(null);
    } catch (err) {
      setMessage(`保存失败：${getErrorMessage(err)}`);
    }
  };

  const handleExecute = (command: QuickCommand) => {
    setActiveMenuId(null);
    execute(command, sessionId).catch((err) => {
      setMessage(`执行失败：${getErrorMessage(err)}`);
    });
  };

  const handleDelete = async (command: QuickCommand) => {
    if (!window.confirm(`删除快捷指令「${command.name}」？`)) return;
    setActiveMenuId(null);
    try {
      await remove(command.id);
      setMessage(null);
    } catch (err) {
      setMessage(`删除失败：${getErrorMessage(err)}`);
    }
  };

  const handleContextMenu = (e: React.MouseEvent, commandId: string) => {
    e.preventDefault();
    setActiveMenuId(activeMenuId === commandId ? null : commandId);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setTab('all')}
            className={`rounded-md px-2 py-1 text-xs ${tab === 'all' ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100'}`}
          >
            全部
          </button>
          <button
            type="button"
            onClick={() => setTab('global')}
            className={`rounded-md px-2 py-1 text-xs ${tab === 'global' ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100'}`}
          >
            全局
          </button>
          <button
            type="button"
            onClick={() => setTab('session')}
            disabled={!canUseSessionCommands}
            className={`rounded-md px-2 py-1 text-xs ${tab === 'session' ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100'} disabled:cursor-not-allowed disabled:opacity-40`}
            title={canUseSessionCommands ? '当前连接快捷指令' : '当前会话未绑定保存的连接配置'}
          >
            当前连接
          </button>
        </div>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索快捷指令..."
          className="flex-1 rounded-md bg-zinc-800 border border-zinc-700 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-indigo-500 placeholder:text-zinc-500"
        />
        <button
          type="button"
          onClick={handleNew}
          disabled={tab === 'session' && !canUseSessionCommands}
          className="rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          新建
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {message && <div className="mb-2 rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-300">{message}</div>}
        {error && <div className="mb-2 rounded-lg bg-red-950/60 px-3 py-2 text-xs text-red-200">{error}</div>}

        {loading ? (
          <div className="py-6 text-center text-sm text-zinc-500">加载中...</div>
        ) : visibleCommands.length === 0 ? (
          <div className="py-6 text-center text-sm text-zinc-500">暂无快捷指令</div>
        ) : (
          <div className="flex flex-col gap-2">
            {visibleCommands.map((command) => (
              <div
                key={command.id}
                className="group relative flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2 transition-all duration-200 hover:border-zinc-600 hover:bg-zinc-900 hover:shadow-md"
                onContextMenu={(e) => handleContextMenu(e, command.id)}
              >
                <button
                  type="button"
                  onClick={() => handleExecute(command)}
                  disabled={!!executingId}
                  className="flex-1 text-left disabled:opacity-60"
                >
                  <div className="text-sm font-medium text-zinc-100 transition-colors group-hover:text-zinc-50">{command.name}</div>
                  <div className="mt-0.5 text-xs text-zinc-500 transition-colors group-hover:text-zinc-400">
                    {tab === 'all' && `${command.scope === 'global' ? '全局' : '当前连接'} · `}
                    {command.commands.length} 条命令 · 间隔 {command.intervalMs} ms
                  </div>
                </button>
                <div className="relative" ref={activeMenuId === command.id ? menuRef : null}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setActiveMenuId(activeMenuId === command.id ? null : command.id);
                    }}
                    className="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                  >
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                      <circle cx="12" cy="5" r="1.5" />
                      <circle cx="12" cy="12" r="1.5" />
                      <circle cx="12" cy="19" r="1.5" />
                    </svg>
                  </button>
                  {activeMenuId === command.id && (
                    <div className="absolute right-0 top-full z-10 mt-1 w-24 rounded-lg border border-zinc-700 bg-zinc-800 p-1 shadow-lg">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setForm(commandToForm(command));
                          setActiveMenuId(null);
                        }}
                        className="w-full rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-700"
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(command);
                        }}
                        className="w-full rounded px-2 py-1.5 text-left text-xs text-red-400 hover:bg-red-950/60"
                      >
                        删除
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {form && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-96 rounded-xl bg-zinc-800 border border-zinc-700 shadow-2xl p-4">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3">
              {form.id ? '编辑快捷指令' : '新建快捷指令'}
            </h3>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-zinc-400">名称</label>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full rounded-md bg-zinc-900 border border-zinc-700 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-indigo-500"
                  placeholder="例如：查看磁盘"
                  autoFocus
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block text-xs text-zinc-400">作用域</label>
                  <select
                    value={form.scope}
                    onChange={(e) => setForm({ ...form, scope: e.target.value as QuickCommandScope | '' })}
                    className="w-full rounded-md bg-zinc-900 border border-zinc-700 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-indigo-500"
                  >
                    <option value="" disabled>请选择</option>
                    <option value="global">全局</option>
                    <option value="session" disabled={!canUseSessionCommands}>当前连接</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-zinc-400">间隔 ms</label>
                  <input
                    type="number"
                    min={0}
                    value={form.intervalMs}
                    onChange={(e) => setForm({ ...form, intervalMs: Number(e.target.value) })}
                    className="w-full rounded-md bg-zinc-900 border border-zinc-700 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-indigo-500"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs text-zinc-400">命令（一行一条，按顺序执行）</label>
                <textarea
                  value={form.commandsText}
                  onChange={(e) => setForm({ ...form, commandsText: e.target.value })}
                  rows={4}
                  className="w-full resize-none rounded-md bg-zinc-900 border border-zinc-700 px-2 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-indigo-500"
                  placeholder={'pwd\ndf -h'}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button
                type="button"
                onClick={() => setForm(null)}
                className="px-3 py-1.5 rounded-lg text-xs text-zinc-300 bg-zinc-700 hover:bg-zinc-600"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                className="px-3 py-1.5 rounded-lg text-xs text-white bg-indigo-600 hover:bg-indigo-500"
              >
                保存
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
