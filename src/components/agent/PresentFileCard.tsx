import type { AgentMessage } from '@/lib/types';
import { fileBaseName, fileLinkKind, parsePresentFileMeta } from '@/lib/fileLink';
import { runFileAction } from '@/lib/fileNav';
import { formatSize } from '@/lib/sftp-helpers';
import { useContext } from 'react';
import ToolCallCard from './ToolCallCard';
import { FileKindIcon, fileTooltip } from './FileLinkChip';
import { MessageJumpContext } from './messageJumpContext';
import { useFileLinkBehavior } from './useFileLinkMenu';
import type { ToolViewProps } from './toolViews';

/**
 * agent 的「交付文件」卡片（`present_file` / `local_present_file` 的专属 view，桌面手机同一个组件）。
 * 成品一眼可见：文件名 / 标题、一句说明、路径与大小，主按钮直接打开，次按钮在文件管理里定位；
 * 右键（手机长按）与路径链接是同一份菜单。失败的调用没有 metadata，退回通用工具卡看原因。
 */
export default function PresentFileView({ message, grouped }: ToolViewProps) {
  const meta = message.toolResult?.success === true ? parsePresentFileMeta(message.toolResult.metadata) : null;
  const wrap = grouped ? 'pl-3' : '';
  return (
    <div className={`flex min-w-0 justify-start ${wrap}`}>
      <div className="min-w-0 max-w-[85%]">
        {meta ? <DeliveredFile meta={meta} /> : <ToolCallCard message={message as AgentMessage} />}
      </div>
    </div>
  );
}

function DeliveredFile({ meta }: { meta: NonNullable<ReturnType<typeof parsePresentFileMeta>> }) {
  const { ref } = meta;
  const conversationId = useContext(MessageJumpContext)?.conversationId ?? null;
  const { machine, activate, onContextMenu, menu } = useFileLinkBehavior(ref);
  const disabled = !machine.ok;
  const kind = fileLinkKind(ref);
  const detail = [ref.side === 'local' ? '本机' : ref.host, meta.size != null ? formatSize(meta.size) : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <div
      onContextMenu={onContextMenu}
      title={fileTooltip(ref, machine.ok ? undefined : machine.reason)}
      className="min-w-0 rounded-xl border border-edge bg-zinc-900/60 p-3"
    >
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">交付文件</div>
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-state-soft text-sky-300">
          <FileKindIcon kind={kind} className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-zinc-100">{meta.title ?? fileBaseName(ref.path)}</div>
          {meta.note && <div className="mt-0.5 text-xs text-zinc-300 [overflow-wrap:anywhere]">{meta.note}</div>}
          <div className="mt-1 break-all font-mono text-[11px] text-zinc-500">{ref.path}</div>
          {detail && <div className="mt-0.5 text-[11px] text-zinc-500">{detail}</div>}
        </div>
      </div>
      {disabled && machine.ok === false && (
        <div className="mt-2 text-xs text-amber-300/90">{machine.reason}</div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={activate}
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-500 active:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-indigo-600"
        >
          打开
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => void runFileAction('reveal', ref, { conversationId })}
          className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 transition-colors hover:bg-state-mid active:bg-state-mid disabled:cursor-not-allowed disabled:opacity-40"
        >
          {ref.side === 'local' ? '在文件夹中显示' : '在文件管理中显示'}
        </button>
      </div>
      {menu}
    </div>
  );
}
