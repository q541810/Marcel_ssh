import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Activity, AlertTriangle, ArrowLeft, ArrowRight, Binary, Bug, Check, Eye, FlaskConical, Plus, PlugZap, Server, Sun } from "lucide-react";
import { isDebugConnection } from "@/lib/debugServer";
import * as tauri from "@/lib/tauri";
import ErrorScreen from "@/components/layout/ErrorScreen";
import { useConnectionStore } from "@/stores/connectionStore";
import { useViewStore } from "@/stores/viewStore";
import { useDebugStore } from "@/stores/debugStore";
import { getBackDiagnostics, subscribeBackDiagnostics } from "@/mobile/backHandler";

/** 预览用的示例错误：手工 stack 让预览屏与真实崩溃形态一致（含缩进的调用栈）。 */
const sampleError = new TypeError("Cannot read properties of undefined (reading 'map')");
sampleError.stack = [
  "TypeError: Cannot read properties of undefined (reading 'map')",
  "    at MessageList (src/components/agent/AgentMessageList.tsx:42:18)",
  "    at renderWithHooks (react-dom.development.js:15486:18)",
  "    at beginWork (react-dom.development.js:19167:14)",
  "    at performUnitOfWork (react-dom.development.js:23179:12)",
].join("\n");

/**
 * 返回手势诊断（仅 Android）：原生有没有把手势进度送到网页。
 * 本页自己就是一个返回层，从屏幕边缘慢慢滑一半再收回来，计数就会变。
 */
function BackGestureDiagnostics() {
  const d = useSyncExternalStore(subscribeBackDiagnostics, getBackDiagnostics);
  const rows: Array<[string, string]> = [
    ["网页层返回栈深度", String(d.stackDepth)],
    ["已通知原生接管手势", d.interceptSent == null ? "从未通知" : d.interceptSent ? "是" : "否"],
    ["手势开始（原生→网页）", String(d.starts)],
    ["手势进度帧（原生→网页）", `${d.frames}（最近 ${d.lastProgress.toFixed(2)}）`],
    ["手势取消", String(d.cancels)],
    ["确认返回", String(d.commits)],
    ["栈顶层带预览", d.topHadPreview == null ? "—" : d.topHadPreview ? "是" : "否"],
    ["系统开了减弱动画", d.reducedMotion ? "是（预览会被跳过）" : "否"],
  ];
  return (
    <section
      className="mt-4 rounded-xl border border-edge-subtle bg-surface-sunken/50 p-4"
      aria-labelledby="debug-back-title"
    >
      <div className="flex items-start gap-3">
        <Activity className="mt-1 h-5 w-5 shrink-0 text-fg-secondary" aria-hidden="true" />
        <div className="min-w-0">
          <h2 id="debug-back-title" className="text-body font-medium text-fg">返回手势诊断</h2>
          <p className="mt-1 text-body leading-6 text-fg-secondary">
            在本页从屏幕边缘慢慢向内滑一半、再滑回去（别松手到底）。「手势开始」和「进度帧」不涨，说明系统没把手势进度交给应用；涨了说明链路是通的。
          </p>
        </div>
      </div>
      <dl className="mt-3 space-y-2 text-meta">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-3">
            <dt className="text-fg-tertiary">{k}</dt>
            <dd className="font-mono text-fg">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

interface DebugPageProps {
  onBack?: () => void;
  onShowServers?: () => void;
}

export default function DebugPage({ onBack, onShowServers }: DebugPageProps) {
  const added = useConnectionStore((state) =>
    state.connections.some((connection) => isDebugConnection(connection.id)),
  );
  const addDebugServer = () => useConnectionStore.getState().addDebugServer();
  const forceReasoningEffortPicker = useDebugStore(
    (state) => state.forceReasoningEffortPicker,
  );
  const setForceReasoningEffortPicker = useDebugStore(
    (state) => state.setForceReasoningEffortPicker,
  );
  const lightMode = useDebugStore((state) => state.lightMode);
  const setLightMode = useDebugStore((state) => state.setLightMode);
  const debug67Mode = useDebugStore((state) => state.debug67Mode);
  const setDebug67Mode = useDebugStore((state) => state.setDebug67Mode);
  const debug67TokenLimit = useDebugStore((state) => state.debug67TokenLimit);
  const setDebug67TokenLimit = useDebugStore((state) => state.setDebug67TokenLimit);
  const debug67Speed = useDebugStore((state) => state.debug67Speed);
  const setDebug67Speed = useDebugStore((state) => state.setDebug67Speed);
  const debug67Thinking = useDebugStore((state) => state.debug67Thinking);
  const setDebug67Thinking = useDebugStore((state) => state.setDebug67Thinking);
  const [pluginReloading, setPluginReloading] = useState(false);
  const [pluginReloadStatus, setPluginReloadStatus] = useState<string | null>(null);
  const [errorPreviewOpen, setErrorPreviewOpen] = useState(false);

  // 预览覆盖层支持 Escape 退出（与关闭按钮等价）。
  useEffect(() => {
    if (!errorPreviewOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setErrorPreviewOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [errorPreviewOpen]);
  const fallbackBack = () =>
    useViewStore.getState().setActiveId("builtin.settings");
  const fallbackServers = () =>
    useViewStore.getState().setActiveId("builtin.sessions");

  const reloadPlugins = useCallback(async () => {
    if (pluginReloading) return;
    setPluginReloading(true);
    setPluginReloadStatus(null);
    try {
      const diff = await tauri.pluginReload();
      setPluginReloadStatus(
        `已尝试热重载插件：变更 ${diff.changed.length} 个，移除 ${diff.removed.length} 个。`,
      );
    } catch {
      setPluginReloadStatus("插件热重载失败，请查看日志后重试。");
    } finally {
      setPluginReloading(false);
    }
  }, [pluginReloading]);

  return (
    <main
      className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-surface p-5 text-fg sm:p-7"
      data-region="debug"
    >
      <div className="mx-auto w-full max-w-2xl">
        <button
          type="button"
          onClick={onBack ?? fallbackBack}
          className="-ml-2 mb-5 flex min-h-9 items-center gap-2 rounded-lg px-2 text-body text-fg-secondary transition-colors hover:bg-state-soft hover:text-fg focus-visible:outline-2 focus-visible:outline-indigo-400"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          返回设置
        </button>
        <div className="flex items-center gap-2">
          <Bug className="h-5 w-5 text-indigo-400" aria-hidden="true" />
          <h1 className="text-headline text-fg">调试</h1>
        </div>
        <p className="mt-2 text-body leading-6 text-fg-secondary">
          虚拟服务器仅在本次运行中有效，重启应用后自动移除。
        </p>
        <section
          className="mt-6 rounded-xl border border-edge-subtle bg-surface-sunken/50 p-4"
          aria-labelledby="debug-server-title"
        >
          <div className="flex items-start gap-3">
            <Server
              className="mt-1 h-5 w-5 shrink-0 text-fg-secondary"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <h2
                id="debug-server-title"
                className="text-body font-medium text-fg"
              >
                虚拟服务器
              </h2>
              <p className="mt-1 text-body leading-6 text-fg-secondary">
                将 msfakeserver 添加到服务器列表，可直接免密连接并打开模拟终端。
              </p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={addDebugServer}
              disabled={added}
              className="flex min-h-10 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-body font-medium text-white transition-colors hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-300 disabled:cursor-default disabled:bg-surface-raised disabled:text-fg-secondary"
            >
              {added ? (
                <Check className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Plus className="h-4 w-4" aria-hidden="true" />
              )}
              {added ? "已添加虚拟服务器" : "添加虚拟服务器"}
            </button>
            {added && (
              <button
                type="button"
                onClick={onShowServers ?? fallbackServers}
                className="flex min-h-10 items-center gap-2 rounded-lg px-3 py-2 text-body text-indigo-300 transition-colors hover:bg-state-soft focus-visible:outline-2 focus-visible:outline-indigo-400"
              >
                去服务器列表
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>
          <p
            role="status"
            className="mt-3 min-h-5 text-meta leading-5 text-fg-secondary"
          >
            {added
              ? "msfakeserver 已在服务器列表中。"
              : "添加后可从常规服务器列表连接。"}
          </p>
        </section>

        <section
          className="mt-4 rounded-xl border border-indigo-900/60 bg-indigo-950/20 p-4"
          aria-labelledby="debug-reasoning-title"
        >
          <div className="flex items-start gap-3">
            <Bug className="mt-1 h-5 w-5 shrink-0 text-indigo-300" aria-hidden="true" />
            <div className="min-w-0">
              <h2 id="debug-reasoning-title" className="text-body font-medium text-indigo-100">思考强度调试</h2>
              <p className="mt-1 text-body leading-6 text-indigo-200/70">强制在模型设置中显示思考强度滑条，即使当前模型没有声明可用档位。</p>
            </div>
          </div>
          <label className="mt-4 flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-body text-fg hover:bg-surface/50">
            <input
              type="checkbox"
              checked={forceReasoningEffortPicker}
              onChange={(event) => setForceReasoningEffortPicker(event.currentTarget.checked)}
              className="h-4 w-4 accent-indigo-500"
            />
            <span>强制显示思考强度滑条</span>
          </label>
          <p className="mt-2 text-meta leading-5 text-fg-tertiary">未声明的档位仅用于界面调试，模型可能不会应用该设置。</p>
        </section>

        <section
          className="mt-4 rounded-xl border border-edge-subtle bg-surface-sunken/50 p-4"
          aria-labelledby="debug-plugin-title"
        >
          <div className="flex items-start gap-3">
            <PlugZap className="mt-1 h-5 w-5 shrink-0 text-fg-secondary" aria-hidden="true" />
            <div className="min-w-0">
              <h2 id="debug-plugin-title" className="text-body font-medium text-fg">插件</h2>
              <p className="mt-1 text-body leading-6 text-fg-secondary">重新扫描插件目录并尝试应用插件注册表变化。</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void reloadPlugins()}
            disabled={pluginReloading}
            className="mt-4 flex min-h-10 items-center gap-2 rounded-lg border border-edge bg-surface-raised px-3 py-2 text-body font-medium text-fg transition-colors hover:bg-state-mid focus-visible:outline-2 focus-visible:outline-indigo-400 disabled:cursor-wait disabled:opacity-60"
          >
            <PlugZap className="h-4 w-4" aria-hidden="true" />
            {pluginReloading ? "正在尝试热重载…" : "尝试热重载插件"}
          </button>
          <p className="mt-2 min-h-5 text-meta leading-5 text-fg-secondary" role="status">{pluginReloadStatus}</p>
        </section>

        <section
          className="mt-4 rounded-xl border border-edge-subtle bg-surface-sunken/50 p-4"
          aria-labelledby="debug-error-screen-title"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-1 h-5 w-5 shrink-0 text-amber-300" aria-hidden="true" />
            <div className="min-w-0">
              <h2 id="debug-error-screen-title" className="text-body font-medium text-fg">
                错误界面预览
              </h2>
              <p className="mt-1 text-body leading-6 text-fg-secondary">
                以示例错误全屏预览应用崩溃时的兜底界面（含复制错误信息与交流群反馈引导），不影响真实状态。
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setErrorPreviewOpen(true)}
            className="mt-4 flex min-h-10 items-center gap-2 rounded-lg border border-edge bg-surface-raised px-3 py-2 text-body font-medium text-fg transition-colors hover:bg-state-mid focus-visible:outline-2 focus-visible:outline-indigo-400"
          >
            <Eye className="h-4 w-4" aria-hidden="true" />
            预览错误界面
          </button>
        </section>

        <section
          className="mt-4 rounded-xl border border-edge-subtle bg-surface-sunken/50 p-4"
          aria-labelledby="debug-experimental-title"
        >
          <div className="flex items-start gap-3">
            <FlaskConical className="mt-1 h-5 w-5 shrink-0 text-fg-secondary" aria-hidden="true" />
            <div className="min-w-0">
              <h2 id="debug-experimental-title" className="text-body font-medium text-fg">实验性功能</h2>
              <p className="mt-1 text-body leading-6 text-fg-tertiary">开启尚在测试中的界面实验，状态会保留到手动关闭。</p>
            </div>
          </div>
          <label className="mt-4 flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-body text-fg hover:bg-surface/50">
            <input
              type="checkbox"
              checked={lightMode}
              onChange={(event) => setLightMode(event.currentTarget.checked)}
              className="h-4 w-4 accent-indigo-500"
            />
            <span className="flex items-center gap-2">
              <Sun className="h-4 w-4 text-amber-300" aria-hidden="true" />
              亮色模式
            </span>
          </label>
          <p className="mt-1 text-meta leading-5 text-fg-tertiary">切换后立即预览亮色配色，状态会保留到下次手动关闭。</p>
          <label className="mt-3 flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-body text-fg hover:bg-surface/50">
            <input
              type="checkbox"
              checked={debug67Mode}
              onChange={(event) => setDebug67Mode(event.currentTarget.checked)}
              className="h-4 w-4 accent-indigo-500"
            />
            <span className="flex items-center gap-2">
              <Binary className="h-4 w-4 text-cyan-300" aria-hidden="true" />
              67 模式
            </span>
          </label>
          <p className="mt-1 text-meta leading-5 text-fg-tertiary">开启后跳过真实模型，Agent 会模拟连续输出“67”，直到设定的 token 上限；状态会保留到手动关闭。</p>
          {debug67Mode && (
            <div className="mt-3 space-y-3 rounded-lg border border-edge-subtle bg-surface/40 p-3">
              <label className="flex items-center justify-between gap-3 text-body text-fg">
                <span>输出 token 上限</span>
                <input
                  type="number"
                  min={1}
                  max={100000}
                  step={1}
                  value={debug67TokenLimit}
                  onChange={(event) => {
                    const value = Number(event.currentTarget.value);
                    if (Number.isFinite(value)) setDebug67TokenLimit(value);
                  }}
                  className="w-28 rounded-md border border-edge bg-surface-raised px-2 py-1 text-right text-body text-fg outline-none focus:border-indigo-500"
                  aria-label="67 模式输出 token 上限"
                />
              </label>
              <label className="block text-body text-fg">
                <span className="flex items-center justify-between">
                  <span>输出速度</span>
                  <span className="font-mono text-meta text-fg-secondary">{debug67Speed} 段/秒</span>
                </span>
                <input
                  type="range"
                  min={1}
                  max={30}
                  step={1}
                  value={debug67Speed}
                  onChange={(event) => setDebug67Speed(event.currentTarget.valueAsNumber)}
                  className="mt-2 w-full accent-indigo-500"
                  aria-label="67 模式输出速度"
                />
              </label>
              <label className="flex min-h-9 cursor-pointer items-center gap-3 text-body text-fg">
                <input
                  type="checkbox"
                  checked={debug67Thinking}
                  onChange={(event) => setDebug67Thinking(event.currentTarget.checked)}
                  className="h-4 w-4 accent-indigo-500"
                />
                <span>先思考一会儿再输出 67</span>
              </label>
              <p className="text-meta leading-5 text-fg-tertiary">开启思考后会先等待约 1.6 秒，再开始按当前速度输出。</p>
            </div>
          )}
        </section>

        {typeof window !== "undefined" && window.AndroidBridge && <BackGestureDiagnostics />}
      </div>

      {errorPreviewOpen && (
        <div className="fixed inset-0 z-[100001]">
          <ErrorScreen error={sampleError} onClose={() => setErrorPreviewOpen(false)} />
        </div>
      )}
    </main>
  );
}
