import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { File as FileIcon, FileText, Folder, Image as ImageIcon } from 'lucide-react';
import { fileBaseName, fileLinkKind, type FileLinkKind, type FileRef } from '@/lib/fileLink';
import { useFileLinkBehavior } from './useFileLinkMenu';

/** 按文件类型选图标（目录 / 图片 / 文本 / 其它）。 */
export function FileKindIcon({ kind, className }: { kind: FileLinkKind; className?: string }) {
  const Icon = kind === 'dir' ? Folder : kind === 'image' ? ImageIcon : kind === 'text' ? FileText : FileIcon;
  return <Icon className={className ?? 'h-3.5 w-3.5 flex-shrink-0'} aria-hidden />;
}

/** 悬停提示：机器 + 完整路径；不可用时再附上原因。 */
export function fileTooltip(file: FileRef, reason?: string): string {
  const where = file.side === 'local' ? '本机' : file.host;
  const base = where ? `${where} · ${file.path}` : file.path;
  return reason ? `${base}\n${reason}` : base;
}

interface FileLinkChipProps {
  file: FileRef;
  /** 显示文字（markdown 链接的文本）；省略时显示文件名。 */
  label?: ReactNode;
  className?: string;
}

/**
 * 一个可点的文件 / 目录路径芯片——agent 正文里的 `remote:` / `local:` 链接与工具卡片的
 * 路径都用它：左键 = 默认打开（目录 = 在文件管理中显示），右键 / 长按 = 完整菜单。
 * 文件显示成带图标的小芯片；文件夹显示成纯蓝色路径文字。
 * 机器不在线时整条置灰，悬停（手机点按）说明原因，而不是悄悄在别的机器上打开。
 */
export default function FileLinkChip({ file, label, className = '' }: FileLinkChipProps) {
  const { machine, activate, onContextMenu, menu } = useFileLinkBehavior(file);
  const disabled = !machine.ok;
  const isDir = fileLinkKind(file) === 'dir';
  const common = {
    type: 'button' as const,
    'data-file-link': '',
    'aria-disabled': disabled || undefined,
    title: fileTooltip(file, machine.ok ? undefined : machine.reason),
    onClick: (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      activate();
    },
    onContextMenu,
  };
  // 文件夹：就是一段蓝色的路径文字——没有底、没有图标，完整路径照常显示（可换行），点了直接进那个文件夹。
  if (isDir) {
    return (
      <>
        <button
          {...common}
          className={`inline max-w-full touch-manipulation break-all rounded-sm text-left align-baseline font-mono text-[0.9em] [-webkit-touch-callout:none] ${
            disabled ? 'cursor-not-allowed text-zinc-500' : 'cursor-pointer text-sky-300 hover:underline active:opacity-70'
          } ${className}`}
        >
          {label ?? file.path}
        </button>
        {menu}
      </>
    );
  }
  return (
    <>
      <button
        {...common}
        className={`inline-flex max-w-full min-w-0 touch-manipulation select-none items-center gap-1 rounded-md bg-state-soft px-1.5 py-px align-baseline font-mono text-[0.9em] [-webkit-touch-callout:none] transition-colors ${
          disabled
            ? 'cursor-not-allowed text-zinc-500'
            : 'cursor-pointer text-sky-300 hover:bg-state-mid active:bg-state-strong'
        } ${className}`}
      >
        <FileKindIcon kind={fileLinkKind(file)} className="h-3 w-3 flex-shrink-0" />
        <span className="min-w-0 truncate">{label ?? fileBaseName(file.path)}</span>
      </button>
      {menu}
    </>
  );
}
