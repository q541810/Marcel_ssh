import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Binary, Bug, Check, FlaskConical, Plus, PlugZap, Server, Sun } from "lucide-react";
import { isDebugConnection } from "@/lib/debugServer";
import * as tauri from "@/lib/tauri";
import { useConnectionStore } from "@/stores/connectionStore";
import { useViewStore } from "@/stores/viewStore";
import { useDebugStore } from "@/stores/debugStore";

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
  const fallbackBack = () =>
    useViewStore.getState().setActiveId("builtin.settings");
  const fallbackServers = () =>
    useViewStore.getState().setActiveId("builtin.sessions");

  // The light theme is intentionally a debug-only, runtime switch. Keep it
  // on the document root so the shell and any currently mounted view update
  // together when this page is left.
  useEffect(() => {
    if (lightMode) {
      document.documentElement.dataset.marcelTheme = "light";
    } else if (document.documentElement.dataset.marcelTheme === "light") {
      delete document.documentElement.dataset.marcelTheme;
    }
  }, [lightMode]);

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
      className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-zinc-900 p-5 text-zinc-100 sm:p-7"
      data-region="debug"
    >
      <div className="mx-auto w-full max-w-2xl">
        <button
          type="button"
          onClick={onBack ?? fallbackBack}
          className="-ml-2 mb-5 flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-sm text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-indigo-400"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          返回设置
        </button>
        <div className="flex items-center gap-2">
          <Bug className="h-5 w-5 text-indigo-400" aria-hidden="true" />
          <h1 className="text-xl font-semibold text-zinc-100">调试</h1>
        </div>
        <p className="mt-2 text-sm leading-6 text-zinc-400">
          虚拟服务器仅在本次运行中有效，重启应用后自动移除。
        </p>
        <section
          className="mt-6 rounded-xl border border-zinc-800 bg-zinc-950/50 p-4"
          aria-labelledby="debug-server-title"
        >
          <div className="flex items-start gap-3">
            <Server
              className="mt-0.5 h-5 w-5 shrink-0 text-zinc-400"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <h2
                id="debug-server-title"
                className="text-sm font-medium text-zinc-200"
              >
                虚拟服务器
              </h2>
              <p className="mt-1 text-sm leading-6 text-zinc-400">
                将 msfakeserver 添加到服务器列表，可直接免密连接并打开模拟终端。
              </p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={addDebugServer}
              disabled={added}
              className="flex min-h-10 items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-300 disabled:cursor-default disabled:bg-zinc-800 disabled:text-zinc-400"
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
                className="flex min-h-10 items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-indigo-300 transition-colors hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-indigo-400"
              >
                去服务器列表
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>
          <p
            role="status"
            className="mt-3 min-h-5 text-xs leading-5 text-zinc-400"
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
            <Bug className="mt-0.5 h-5 w-5 shrink-0 text-indigo-300" aria-hidden="true" />
            <div className="min-w-0">
              <h2 id="debug-reasoning-title" className="text-sm font-medium text-indigo-100">思考强度调试</h2>
              <p className="mt-1 text-sm leading-6 text-indigo-200/70">强制在模型设置中显示思考强度滑条，即使当前模型没有声明可用档位。</p>
            </div>
          </div>
          <label className="mt-4 flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-sm text-zinc-200 hover:bg-zinc-900/50">
            <input
              type="checkbox"
              checked={forceReasoningEffortPicker}
              onChange={(event) => setForceReasoningEffortPicker(event.currentTarget.checked)}
              className="h-4 w-4 accent-indigo-500"
            />
            <span>强制显示思考强度滑条</span>
          </label>
          <p className="mt-2 text-xs leading-5 text-zinc-500">未声明的档位仅用于界面调试，模型可能不会应用该设置。</p>
        </section>

        <section
          className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950/50 p-4"
          aria-labelledby="debug-plugin-title"
        >
          <div className="flex items-start gap-3">
            <PlugZap className="mt-0.5 h-5 w-5 shrink-0 text-zinc-300" aria-hidden="true" />
            <div className="min-w-0">
              <h2 id="debug-plugin-title" className="text-sm font-medium text-zinc-200">插件</h2>
              <p className="mt-1 text-sm leading-6 text-zinc-400">重新扫描插件目录并尝试应用插件注册表变化。</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void reloadPlugins()}
            disabled={pluginReloading}
            className="mt-4 flex min-h-10 items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm font-medium text-zinc-100 transition-colors hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-indigo-400 disabled:cursor-wait disabled:opacity-60"
          >
            <PlugZap className="h-4 w-4" aria-hidden="true" />
            {pluginReloading ? "正在尝试热重载…" : "尝试热重载插件"}
          </button>
          <p className="mt-2 min-h-5 text-xs leading-5 text-zinc-400" role="status">{pluginReloadStatus}</p>
        </section>

        <section
          className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950/50 p-4"
          aria-labelledby="debug-experimental-title"
        >
          <div className="flex items-start gap-3">
            <FlaskConical className="mt-0.5 h-5 w-5 shrink-0 text-zinc-300" aria-hidden="true" />
            <div className="min-w-0">
              <h2 id="debug-experimental-title" className="text-sm font-medium text-zinc-200">实验性功能</h2>
              <p className="mt-1 text-sm leading-6 text-zinc-500">开启尚在测试中的界面实验，状态会保留到手动关闭。</p>
            </div>
          </div>
          <label className="mt-4 flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-sm text-zinc-200 hover:bg-zinc-900/50">
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
          <p className="mt-1 text-xs leading-5 text-zinc-500">切换后立即预览亮色配色，状态会保留到下次手动关闭。</p>
          <label className="mt-3 flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-sm text-zinc-200 hover:bg-zinc-900/50">
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
          <p className="mt-1 text-xs leading-5 text-zinc-500">开启后跳过真实模型，Agent 会模拟连续输出“67”，直到设定的 token 上限；状态会保留到手动关闭。</p>
          {debug67Mode && (
            <div className="mt-3 space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
              <label className="flex items-center justify-between gap-3 text-sm text-zinc-200">
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
                  className="w-28 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-right text-sm text-zinc-100 outline-none focus:border-indigo-500"
                  aria-label="67 模式输出 token 上限"
                />
              </label>
              <label className="block text-sm text-zinc-200">
                <span className="flex items-center justify-between">
                  <span>输出速度</span>
                  <span className="font-mono text-xs text-zinc-400">{debug67Speed} 段/秒</span>
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
              <label className="flex min-h-9 cursor-pointer items-center gap-3 text-sm text-zinc-200">
                <input
                  type="checkbox"
                  checked={debug67Thinking}
                  onChange={(event) => setDebug67Thinking(event.currentTarget.checked)}
                  className="h-4 w-4 accent-indigo-500"
                />
                <span>先思考一会儿再输出 67</span>
              </label>
              <p className="text-xs leading-5 text-zinc-500">开启思考后会先等待约 1.6 秒，再开始按当前速度输出。</p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
