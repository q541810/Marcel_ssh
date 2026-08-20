import { ShieldCheck, X } from 'lucide-react';

interface MobileKeepAliveTipCardProps {
  onJump: () => void;
  onIgnore: () => void;
  onNeverShow: () => void;
}

/**
 * 连接列表底部的后台保活提示卡片。
 * - 浅色：zinc-900 基底 + 细边框，比 amber 警示更柔和（用户要求比原来浅）
 * - 官方文案：完整说明后台回收风险与建议
 * - 三操作：去开启 / 忽略 / 不再提示
 * - 遵循 apple-design：按下即时反馈（active:scale）、无弹性、1:1 响应
 */
export default function MobileKeepAliveTipCard({
  onJump,
  onIgnore,
  onNeverShow,
}: MobileKeepAliveTipCardProps) {
  return (
    <div className="flex-shrink-0 border-t border-zinc-800 bg-zinc-900 px-3 py-3">
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/80 p-3">
        {/* 头部：图标 + 标题 + 关闭 */}
        <div className="flex items-start gap-2.5">
          <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-zinc-800">
            <ShieldCheck className="h-3.5 w-3.5 text-zinc-400" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium leading-none text-zinc-100">
              后台保活未开启
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">
              检测到后台保活功能未开启，应用在后台运行时可能被系统回收，导致 SSH
              连接中断、Agent 任务暂停。建议前往设置开启后台保活，以保持会话稳定运行。
            </p>
          </div>
          <button
            type="button"
            onClick={onIgnore}
            aria-label="忽略"
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-zinc-500 active:bg-zinc-800 active:text-zinc-300"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* 操作区 */}
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={onJump}
            className="flex-1 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white active:scale-[0.98] active:bg-indigo-500"
          >
            去开启
          </button>
          <button
            type="button"
            onClick={onIgnore}
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs font-medium text-zinc-300 active:scale-[0.98] active:bg-zinc-700"
          >
            忽略
          </button>
        </div>
        <button
          type="button"
          onClick={onNeverShow}
          className="mt-2 w-full py-1 text-center text-[11px] text-zinc-500 active:text-zinc-300"
        >
          不再显示
        </button>
      </div>
    </div>
  );
}
