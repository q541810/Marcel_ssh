import { useEffect, useState } from 'react';
import MobileSheet from './ui/MobileSheet';
import type { FileActionId, FileActionItem, RelativeCandidate } from '@/lib/fileLink';

interface MobileFileLinkSheetProps {
  open: boolean;
  onClose: () => void;
  /** 面板标题：文件名。 */
  title: string;
  items: FileActionItem[];
  onSelect: (id: FileActionId) => void;
  /** 选了「复制相对路径」二级列表里的一项。 */
  onCopyRelative: (candidate: RelativeCandidate) => void;
}

/**
 * agent 消息里文件链接 / 路径芯片的长按面板（手机端的「右键菜单」）。
 * 条目清单来自 `fileLinkActionItems`，与桌面右键菜单同一份；壳用 `MobileSheet`，
 * 它自己负责注册 / 注销返回键处理，所以这里不用再管。
 */
export default function MobileFileLinkSheet({
  open,
  onClose,
  title,
  items,
  onSelect,
  onCopyRelative,
}: MobileFileLinkSheetProps) {
  // 二级列表在同一张面板里切换（不叠第二层面板，返回键行为保持一层）
  const [relativeView, setRelativeView] = useState(false);
  useEffect(() => {
    if (!open) setRelativeView(false);
  }, [open]);
  const relativeItems = items.find((i) => i.id === 'copyRelative')?.children ?? [];
  if (relativeView) {
    return (
      <MobileSheet open={open} onClose={onClose} title="复制相对路径">
        <div className="flex flex-col gap-2 px-4 pb-4">
          {relativeItems.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                onClose();
                onCopyRelative(c);
              }}
              className="rounded-xl bg-zinc-800 px-4 py-3 text-left text-sm text-zinc-100 active:bg-state-mid"
            >
              {c.label}
              <span className="mt-0.5 block break-all font-mono text-[11px] text-zinc-500">{c.text}</span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => setRelativeView(false)}
            className="rounded-xl px-4 py-3 text-sm text-zinc-400 active:bg-state-soft"
          >
            返回
          </button>
        </div>
      </MobileSheet>
    );
  }
  return (
    <MobileSheet open={open} onClose={onClose} title={title}>
      <div className="flex flex-col gap-2 px-4 pb-4">
        {items.map((item, idx) =>
          item.id === 'divider' ? (
            <hr key={`d${idx}`} className="my-1 border-edge" />
          ) : (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                if (item.id === 'copyRelative') {
                  setRelativeView(true);
                  return;
                }
                onClose();
                onSelect(item.id as FileActionId);
              }}
              className="rounded-xl bg-zinc-800 px-4 py-3 text-left text-sm text-zinc-100 active:bg-state-mid"
            >
              {item.label}{item.children ? ' ›' : ''}
              {item.hint && (
                <span className="mt-0.5 block break-all font-mono text-[11px] text-zinc-500">
                  {item.hint}
                </span>
              )}
            </button>
          ),
        )}
        <button
          type="button"
          onClick={onClose}
          className="rounded-xl px-4 py-3 text-sm text-zinc-400 active:bg-state-soft"
        >
          取消
        </button>
      </div>
    </MobileSheet>
  );
}
