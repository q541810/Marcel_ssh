import { useUpdateStore } from '@/stores/updateStore';
import { updatePercent } from '@/lib/updateProgress';

/**
 * 移动端更新下载进度：屏幕顶部一条细进度线 + 左对齐的小胶囊（版本 + 百分比）。
 *
 * 不用浮层/弹窗承接下载中状态 —— 下载是后台行为，弹窗会打断用户正在做的事；
 * 但也不能完全不可见（几十 MB 流量在跑，用户有权知道）。
 *
 * 定位与对齐的取舍：
 * - **绝对定位、叠在安全区下方**，不推动任何布局：移动端内容区是 xterm / 聊天，
 *   为进度条腾出一行会让终端 resize（还会给远端发 window-change），代价太大。
 * - **左对齐而不是右对齐**：各 tab 头部右侧是操作按钮（重连/断开），右下角是发送
 *   键 —— 小胶囊压在按钮上会被当成"界面画错了"。左侧是会话名文字区，同为文字浮层
 *   语义，加深底+描边+阴影后一眼能看出是浮层。
 * - 完成后由 `MobileUpdateToast` 用完整 sheet 说明并征求安装。
 *
 * 不提供取消：Android 的安装始终由用户点击触发，不想装就点「稍后」，没有
 * 「必须先停下」的压力。
 */
export default function MobileUpdateProgress() {
  const state = useUpdateStore((s) => s.state);
  if (state.status !== 'downloading') return null;

  const percent = updatePercent(state.downloaded, state.total);

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-40"
      style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
    >
      <div className="relative h-0.5 w-full bg-indigo-500/15">
        <div
          className="h-full bg-indigo-500 transition-[width] duration-300 ease-out motion-reduce:transition-none"
          style={{ width: `${percent}%` }}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={`正在下载新版本 ${state.version}`}
        />
      </div>
      <div className="flex justify-start px-2 pt-1">
        <span className="rounded-full border border-indigo-500/30 bg-zinc-900/95 px-2 text-[10px] leading-[18px] font-medium text-indigo-300 shadow-lg">
          正在下载 {state.version} · {percent}%
        </span>
      </div>
    </div>
  );
}
