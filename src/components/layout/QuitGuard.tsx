import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { readBusyWork, useBusyWork, useIsBusy } from '@/hooks/useBusyWork';
import { getErrorMessage } from '@/lib/errors';
import { busyConsequences, busyItems, isBusy } from '@/lib/quitGuard';

/** 清单最多列几条；多出来的折成一句「另有 N 项」，别把对话框撑成一页。 */
const MAX_LISTED = 4;

/**
 * 退出确认（桌面）。关主窗口时，如果还有任务在跑（Agent 任务 / 后台作业 / 传输），
 * 先拦下来问一句 —— 关掉窗口会同时中止它们，而这一步用户没法撤销。
 *
 * 这是个 **manager**：它不拥有任何任务，只是把「窗口关闭」与「忙碌清单」
 * （`lib/quitGuard` 的口径，三张表的汇总）接在一起，所以判定全部在 `lib/quitGuard`，
 * 这里只负责拦截时机与对话框。没有任务在跑时**不拦**：Tauri 的默认行为接着关窗，
 * 用户不会为一次普通退出多点一下。
 *
 * 关闭窗口的几种入口（自定义标题栏的 ×、Alt+F4、任务栏右键关闭）最终都是
 * `CloseRequested`，一处拦住即可。确认后用 `destroy()` 强制关闭 —— 走 `close()`
 * 会再次触发 `CloseRequested`，把自己拦在门口。
 *
 * 对话框开着时再次点关闭：事件仍会进来，但对话框已经在了，保持原样（不叠第二个）。
 * 对话框开着期间任务全跑完了：就地改口成「可以放心退出了」，而不是对着一份
 * 过期的清单问「确定要中断吗」。
 *
 * 订阅分两层：常驻的这一层只订阅一个布尔（`useIsBusy`，任务进度 / 传输字节数
 * 每个 tick 的更新不会唤醒它）；要列明细的 {@link QuitDialogBody} 只在对话框打开
 * 期间才挂载，明细订阅也就只在那时存在。
 *
 * **版式必须与应用里其他确认框同款**（对照 `HostKeyMismatchModal`）：`Modal` 自带的
 * 标题栏、`p-4 space-y-4` 的正文、`text-body` 文字、右下「ghost 取消 + danger 确认」。
 * 试过圆形图标 + 大标题 + 带分隔线的内嵌清单卡片，结果在一众朴素的弹窗里格外突兀、
 * 被判定为更丑 —— 别再往里加图标、卡片、分隔线之类的装饰；清单就是几行纯文字。
 */
export default function QuitGuard() {
  const [open, setOpen] = useState(false);
  const [quitting, setQuitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useIsBusy();

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        // 读此刻的 store，而不是上次渲染时的快照：关闭请求可能就夹在状态更新的间隙里。
        if (!isBusy(readBusyWork())) return; // 放行：Tauri 接着关窗
        event.preventDefault();
        setError(null);
        setOpen(true);
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const drained = open && !busy;

  const cancel = () => {
    if (quitting) return;
    setOpen(false);
    setError(null);
  };

  const quit = async () => {
    setQuitting(true);
    setError(null);
    try {
      await getCurrentWindow().destroy();
    } catch (e) {
      setQuitting(false);
      setError(getErrorMessage(e));
    }
  };

  return (
    <Modal open={open} onClose={cancel} size="sm" title={drained ? '任务都已结束' : '还有任务在运行'}>
      <div className="p-4 space-y-4" data-testid="quit-guard">
        <QuitDialogBody drained={drained} />

        {error && <p className="text-body text-red-400">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          {/* 默认焦点给「继续使用」：回车 / 误触都落在安全的一侧 */}
          <Button variant="ghost" onClick={cancel} disabled={quitting} autoFocus>
            {drained ? '取消' : '继续使用'}
          </Button>
          <Button
            variant={drained ? 'primary' : 'danger'}
            onClick={() => void quit()}
            loading={quitting}
          >
            {drained ? '退出' : '仍然退出'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** 对话框正文：忙碌清单与后果（纯文字）。只在对话框挂载期间订阅明细。 */
function QuitDialogBody({ drained }: { drained: boolean }) {
  const work = useBusyWork();
  // 清单回落到空的那一刻（任务跑完了 / 关闭动画还在淡出）内容不能跟着空掉，
  // 否则会闪出一份空清单 —— 留一份最近一次非空的快照。
  const lastBusy = useRef(work);
  if (isBusy(work)) lastBusy.current = work;

  if (drained) {
    return <p className="text-body text-fg-secondary">刚才的任务已经跑完，现在可以放心退出了。</p>;
  }

  const view = isBusy(work) ? work : lastBusy.current;
  const items = busyItems(view);
  const listed = items.slice(0, MAX_LISTED);
  return (
    <>
      <p className="text-body text-fg-secondary">现在退出会中断以下任务：</p>
      <ul className="space-y-2" data-testid="quit-guard-items">
        {listed.map((item) => (
          <li key={item.key} className="flex items-baseline gap-3 text-body">
            <span className="w-8 flex-shrink-0 text-meta text-fg-tertiary">{item.kind}</span>
            <span className="min-w-0 flex-1 truncate text-fg" title={item.text}>
              {item.text}
            </span>
            {item.note && <span className="flex-shrink-0 text-meta text-amber-300">{item.note}</span>}
          </li>
        ))}
        {items.length > listed.length && (
          <li className="pl-11 text-meta text-fg-tertiary">另有 {items.length - listed.length} 项</li>
        )}
      </ul>
      <div className="space-y-1">
        {busyConsequences(view).map((line) => (
          <p key={line} className="text-body text-fg-tertiary">
            {line}
          </p>
        ))}
      </div>
    </>
  );
}
