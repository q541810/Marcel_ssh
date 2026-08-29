import {
  Bot,
  Check,
  Pause,
  Play,
  Plus,
  Send,
  X,
  Zap,
} from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

type SoloTaskStatus = 'running' | 'queued' | 'completed';
type SoloMessageRole = 'user' | 'assistant';

interface SoloMessage {
  id: string;
  role: SoloMessageRole;
  content: string;
  time: string;
}

interface SoloTask {
  id: string;
  title: string;
  summary: string;
  status: SoloTaskStatus;
  progress: number;
  createdAt: string;
  messages: SoloMessage[];
}

const INITIAL_TASKS: SoloTask[] = [
  {
    id: 'solo-task-1',
    title: '检查生产服务器磁盘空间',
    summary: '扫描磁盘使用率并整理异常目录',
    status: 'running',
    progress: 68,
    createdAt: '刚刚',
    messages: [],
  },
  {
    id: 'solo-task-2',
    title: '整理项目日志',
    summary: '归档最近 7 天的应用日志',
    status: 'queued',
    progress: 0,
    createdAt: '2 分钟前',
    messages: [],
  },
  {
    id: 'solo-task-3',
    title: '生成部署摘要',
    summary: '汇总本次发布的变更与风险点',
    status: 'completed',
    progress: 100,
    createdAt: '昨天',
    messages: [],
  },
];

function formatNow(): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date());
}

function statusMeta(status: SoloTaskStatus) {
  if (status === 'running') {
    return {
      dot: 'bg-emerald-400',
    };
  }
  if (status === 'completed') {
    return {
      dot: 'bg-zinc-500',
    };
  }
  return {
    dot: 'bg-amber-400',
  };
}

export default function SoloPage() {
  const [tasks, setTasks] = useState<SoloTask[]>(INITIAL_TASKS);
  const [activeTaskId, setActiveTaskId] = useState(INITIAL_TASKS[0].id);
  const [isAddingTask, setIsAddingTask] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [draft, setDraft] = useState('');
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const messageListRef = useRef<HTMLDivElement>(null);

  const activeTask = tasks.find((task) => task.id === activeTaskId) ?? tasks[0];
  const runningCount = tasks.filter((task) => task.status === 'running').length;

  useEffect(() => {
    const list = messageListRef.current;
    if (!list) return;
    list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
  }, [activeTaskId, activeTask?.messages.length]);

  useEffect(() => {
    return () => {
      Object.values(timersRef.current).forEach((timer) => clearTimeout(timer));
    };
  }, []);

  const updateTask = (taskId: string, updater: (task: SoloTask) => SoloTask) => {
    setTasks((current) => current.map((task) => (task.id === taskId ? updater(task) : task)));
  };

  const appendMessage = (taskId: string, message: SoloMessage) => {
    updateTask(taskId, (task) => ({ ...task, messages: [...task.messages, message] }));
  };

  const startTask = (taskId: string) => {
    const task = tasks.find((item) => item.id === taskId);
    if (!task || task.status === 'running') return;

    if (timersRef.current[taskId]) clearTimeout(timersRef.current[taskId]);
    updateTask(taskId, (current) => ({
      ...current,
      status: 'running',
      progress: current.status === 'completed' ? 12 : Math.max(current.progress, 12),
    }));

    timersRef.current[taskId] = setTimeout(() => {
      updateTask(taskId, (current) => ({
        ...current,
        status: 'completed',
        progress: 100,
      }));
      delete timersRef.current[taskId];
    }, 3200);
  };

  const stopTask = (taskId: string) => {
    if (timersRef.current[taskId]) {
      clearTimeout(timersRef.current[taskId]);
      delete timersRef.current[taskId];
    }
    updateTask(taskId, (current) => ({
      ...current,
      status: 'queued',
      progress: 0,
    }));
  };

  const handleCreateTask = () => {
    const title = newTaskTitle.trim();
    if (!title) return;

    const task: SoloTask = {
      id: `solo-task-${Date.now()}`,
      title,
      summary: '新建任务，等待你的下一步指令',
      status: 'queued',
      progress: 0,
      createdAt: '刚刚',
      messages: [],
    };
    setTasks((current) => [task, ...current]);
    setActiveTaskId(task.id);
    setNewTaskTitle('');
    setIsAddingTask(false);
  };

  const sendMessage = () => {
    const content = draft.trim();
    if (!content || !activeTask) return;

    const taskId = activeTask.id;
    appendMessage(taskId, {
      id: `message-${Date.now()}`,
      role: 'user',
      content,
      time: formatNow(),
    });
    setDraft('');
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  };

  if (!activeTask) return null;

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-zinc-900 text-zinc-100">
      <aside className="flex w-[304px] min-w-[260px] flex-shrink-0 flex-col border-r border-zinc-800 bg-zinc-900">
        <div className="border-b border-zinc-800/80 px-5 py-4">
          <button
            onClick={() => setIsAddingTask((current) => !current)}
            className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-3 text-xs font-semibold text-white hover:bg-indigo-500"
          >
            {isAddingTask ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {isAddingTask ? '取消新增' : '新增任务'}
          </button>

          {isAddingTask && (
            <div className="mt-3 flex gap-2">
              <input
                autoFocus
                value={newTaskTitle}
                onChange={(event) => setNewTaskTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') handleCreateTask();
                  if (event.key === 'Escape') setIsAddingTask(false);
                }}
                placeholder="例如：分析 nginx 错误日志"
                className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-3 text-xs text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-indigo-500"
              />
              <button
                onClick={handleCreateTask}
                disabled={!newTaskTitle.trim()}
                className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-zinc-800 text-indigo-300 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
                title="创建任务"
                aria-label="创建任务"
              >
                <Check className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <div className="mb-2 flex items-center justify-between px-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-600">任务列表</span>
          </div>

          <div className="space-y-1.5">
            {tasks.map((task) => {
              const meta = statusMeta(task.status);
              const isActive = task.id === activeTask.id;
              return (
                <div
                  key={task.id}
                  className={`group flex items-stretch rounded-lg border transition-colors ${
                    isActive
                      ? 'border-indigo-700 bg-indigo-900/30'
                      : 'border-transparent hover:border-zinc-800 hover:bg-zinc-900/70'
                  }`}
                >
                  <button
                    onClick={() => setActiveTaskId(task.id)}
                    className="min-w-0 flex-1 px-3 py-3 text-left"
                  >
                    <div className="flex items-start gap-2.5">
                      <span className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${meta.dot}`} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-medium text-zinc-200">{task.title}</div>
                        <div className="mt-1 truncate text-[11px] text-zinc-600">{task.summary}</div>
                        <div className="mt-2 flex items-center gap-2 text-[10px]">
                          <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                          <span className="text-zinc-600">{task.createdAt}</span>
                        </div>
                      </div>
                    </div>
                    {task.status === 'running' && (
                      <div className="ml-[18px] mt-2 h-1 overflow-hidden rounded-full bg-zinc-800">
                        <div
                          className="h-full rounded-full bg-emerald-400 transition-[width] duration-500"
                          style={{ width: `${task.progress}%` }}
                        />
                      </div>
                    )}
                  </button>
                  <div className="flex w-9 flex-shrink-0 items-center justify-center pr-1">
                    {task.status === 'running' ? (
                      <button
                        onClick={() => stopTask(task.id)}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 opacity-0 hover:bg-zinc-800 hover:text-zinc-200 group-hover:opacity-100"
                        title="暂停任务"
                        aria-label={`暂停任务：${task.title}`}
                      >
                        <Pause className="h-3.5 w-3.5" />
                      </button>
                    ) : (
                      <button
                        onClick={() => startTask(task.id)}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 opacity-0 hover:bg-emerald-400/10 hover:text-emerald-300 group-hover:opacity-100"
                        title="开始任务"
                        aria-label={`开始任务：${task.title}`}
                      >
                        <Play className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="border-t border-zinc-800/80 px-5 py-4">
          <div className="flex items-center gap-2 text-[11px] text-zinc-500">
            <Zap className="h-3.5 w-3.5 text-indigo-400" />
            <span>{runningCount > 0 ? `${runningCount} 个任务正在并行运行` : '可同时启动多个任务'}</span>
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col bg-zinc-900">
        <header className="flex min-h-[52px] items-center justify-between gap-4 border-b border-zinc-800 px-3 py-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <h2 className="text-sm font-semibold text-zinc-200">智能助手</h2>
            <span className="text-zinc-700">·</span>
            <span className="truncate text-xs text-zinc-500">{activeTask.title}</span>
          </div>
        </header>

        <div ref={messageListRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-3 space-y-1">
          {activeTask.messages.length === 0 ? (
            <div className="text-center text-zinc-500 text-sm mt-8">
              <p>暂无消息。</p>
              <p className="mt-1">描述您想要做的事情，智能助手将为您提供帮助。</p>
            </div>
          ) : (
            activeTask.messages.map((message) =>
              message.role === 'user' ? (
                <div key={message.id} className="group flex justify-end my-1">
                  <div className="flex max-w-[80%] flex-col items-end">
                    <div className="max-w-full whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-zinc-700 px-4 py-2 text-[15px] leading-relaxed text-white">
                      {message.content}
                    </div>
                    <div className="mt-1 flex w-max max-w-full items-center text-[11px] text-zinc-500">
                      {message.time}
                    </div>
                  </div>
                </div>
              ) : (
                <div key={message.id} className="flex justify-start my-1">
                  <div className="max-w-[90%] whitespace-pre-wrap text-[15px] leading-relaxed text-zinc-100">
                    {message.content}
                  </div>
                </div>
              ),
            )
          )}
        </div>

        <div className="border-t border-zinc-800 p-3">
          <div className="mx-auto w-full max-w-3xl">
            <div className="rounded-lg border border-zinc-700 bg-zinc-800 focus-within:border-indigo-500">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                rows={3}
                placeholder="告诉 AI 下一步要做什么..."
                className="block w-full resize-none bg-transparent px-3 py-2.5 text-sm leading-relaxed text-zinc-100 outline-none placeholder:text-zinc-500"
              />
              <div className="flex items-center justify-between border-t border-zinc-700 px-2 py-2">
                <div className="flex items-center gap-2 text-[10px] text-zinc-600">
                  <Bot className="h-3.5 w-3.5 text-indigo-400" />
                  <span>SOLO 助手</span>
                </div>
                <button
                  onClick={sendMessage}
                  disabled={!draft.trim()}
                  className="flex h-8 w-8 items-center justify-center rounded-md bg-indigo-600 text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
                  title="发送消息"
                  aria-label="发送消息"
                >
                  <Send className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <div className="mt-2 flex items-center justify-between px-1 text-[10px] text-zinc-700">
              <span>消息只保存在当前页面</span>
              <span>Shift + Enter 换行</span>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
