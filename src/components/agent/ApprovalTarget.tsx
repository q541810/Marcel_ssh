import { Monitor, Server } from 'lucide-react';

/**
 * 审批里「这个操作在哪台机器上跑」的声明，一行一条。
 *
 * 这是安全信息：批准一条打在别的机器、或用户自己电脑上的操作，必须看得见执行对象
 * （判据是**工具名**而不是参数 —— 参数由模型生成，可以伪造，调用方传进来前已经按
 * catalog 判定）。它靠**位置**（紧贴在命令正上方）和**字重**（机器名加粗、提亮）
 * 保持醒目，而不是靠彩色底框 —— 颜色只给机器名本身一点点琥珀，让「别的服务器」和
 * 「你自己的电脑」仍然一眼能分。桌面审批弹窗与手机审批底部面板共用。
 */
export function ApprovalTarget({
  targetHost,
  isLocalTool,
  isLocalSubagent,
}: {
  /** 命令带 host = 跨机执行；空串 = 当前会话。 */
  targetHost: string;
  /** 本机工具（运行 Marcel SSH 的这台电脑）。 */
  isLocalTool: boolean;
  isLocalSubagent: boolean;
}) {
  if (!targetHost && !isLocalTool) return null;
  return (
    <div className="space-y-1 text-meta">
      {targetHost && (
        <div className="flex items-start gap-2 text-fg-secondary">
          <Server className="mt-[3px] h-3.5 w-3.5 shrink-0 text-fg-tertiary" aria-hidden />
          <span className="min-w-0 break-words">
            在 <span className="font-semibold text-amber-300">{targetHost}</span> 上执行
            <span className="text-fg-tertiary"> · 非当前会话</span>
          </span>
        </div>
      )}
      {isLocalTool && (
        <div className="flex items-start gap-2 text-fg-secondary">
          <Monitor className="mt-[3px] h-3.5 w-3.5 shrink-0 text-fg-tertiary" aria-hidden />
          <span className="min-w-0 break-words">
            <span className="font-semibold text-sky-300">本机</span>
            <span className="text-fg-tertiary">
              {isLocalSubagent
                ? ' · 子 agent 只在运行 Marcel SSH 的这台电脑上工作'
                : ' · 在运行 Marcel SSH 的这台电脑上执行，不经 SSH'}
            </span>
          </span>
        </div>
      )}
    </div>
  );
}
