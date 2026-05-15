import { useEffect, useMemo, useState } from 'react';
import type { QuickCommand, QuickCommandInput, QuickCommandScope } from '@/lib/types';
import { useQuickCommandStore } from '@/stores/quickCommandStore';

interface QuickCommandBarProps {
  sessionId: string;
  sessionKey?: string | null;
}

interface FormState {
  id?: string;
  scope: QuickCommandScope;
  name: string;
  commandsText: string;
  intervalMs: number;
}

const emptyForm = (scope: QuickCommandScope, sessionKey?: string | null): FormState => ({
  scope: sessionKey ? scope : 'global',
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

export default function QuickCommandBar({ sessionId, sessionKey }: QuickCommandBarProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<QuickCommandScope>('global');
  const [form, setForm] = useState<FormState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
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
    if (!open) return;
    load(sessionKey).catch((err) => setMessage(`加载失败：${String(err)}`));
  }, [open, sessionKey, load]);

  useEffect(() => {
    if (!sessionKey && tab === 'session') {
      setTab('global');
    }
  }, [sessionKey, tab]);

  const visibleCommands = useMemo(() => {
    return commands.filter((command) => command.scope === tab);
  }, [commands, tab]);

  const canUseSessionCommands = !!sessionKey;

  const handleNew = (scope: QuickCommandScope) => {
    setForm(emptyForm(scope, sessionKey));
    setMessage(null);
  };

  const handleSubmit = async () => {
    if (!form) return;
    const commandLines = parseCommands(form.commandsText);
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
      setTab(payload.scope);
      setMessage(null);
    } catch (err) {
      setMessage(`保存失败：${String(err)}`);
    }
  };

  const handleExecute = (command: QuickCommand) => {
    setOpen(false);
    execute(command, sessionId).catch((err) => {
      setMessage(`执行失败：${String(err)}`);
    });
  };

  const handleDelete = async (command: QuickCommand) => {
    if (!window.confirm(`删除快捷指令「${command.name}」？`)) return;
    try {
      await remove(command.id);
      setMessage(null);
    } catch (err) {
      setMessage(`删除失败：${String(err)}`);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-zinc-600 hover:bg-zinc-700 hover:text-zinc-100"
      >
        快捷指令
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-40 mb-2 w-[28rem] max-w-[calc(100vw-2rem)] rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
          <div className="flex items-center gap-1 border-b border-zinc-800 px-3 py-2">
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
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => handleNew(tab)}
              disabled={tab === 'session' && !canUseSessionCommands}
              className="rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              新建
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setForm(null);
              }}
              className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            >
              关闭
            </button>
          </div>

          <div className="max-h-80 overflow-y-auto p-3">
            {message && <div className="mb-2 rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-300">{message}</div>}
            {error && <div className="mb-2 rounded-lg bg-red-950/60 px-3 py-2 text-xs text-red-200">{error}</div>}

            {form ? (
              <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
                <div>
                  <label className="mb-1 block text-xs text-zinc-400">名称</label>
                  <input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500"
                    placeholder="例如：查看磁盘"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="mb-1 block text-xs text-zinc-400">作用域</label>
                    <select
                      value={form.scope}
                      onChange={(e) => setForm({ ...form, scope: e.target.value as QuickCommandScope })}
                      className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500"
                    >
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
                      className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500"
                    />
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-zinc-400">命令（一行一条，按顺序执行）</label>
                  <textarea
                    value={form.commandsText}
                    onChange={(e) => setForm({ ...form, commandsText: e.target.value })}
                    rows={5}
                    className="w-full resize-none rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-indigo-500"
                    placeholder={'pwd\ndf -h'}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setForm(null)}
                    className="rounded-md px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={handleSubmit}
                    className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
                  >
                    保存
                  </button>
                </div>
              </div>
            ) : loading ? (
              <div className="py-8 text-center text-sm text-zinc-500">加载中...</div>
            ) : visibleCommands.length === 0 ? (
              <div className="py-8 text-center text-sm text-zinc-500">暂无快捷指令</div>
            ) : (
              <div className="space-y-2">
                {visibleCommands.map((command) => (
                  <div key={command.id} className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-2">
                    <div className="flex items-start gap-2">
                      <button
                        type="button"
                        onClick={() => handleExecute(command)}
                        disabled={!!executingId}
                        className="min-w-0 flex-1 text-left disabled:opacity-60"
                      >
                        <div className="truncate text-sm font-medium text-zinc-100">{command.name}</div>
                        <div className="mt-0.5 text-xs text-zinc-500">
                          {command.commands.length} 条命令 · 间隔 {command.intervalMs} ms
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => setForm(commandToForm(command))}
                        className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(command)}
                        className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-red-950/60 hover:text-red-300"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
