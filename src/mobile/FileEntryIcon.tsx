import type { SftpFileEntry } from '@/lib/types';
import { entryBadge } from './filesUi';

/**
 * 文件列表图标：与桌面文件管理器同一套图形与配色（实心黄文件夹 / 青色链接 /
 * 灰色文档），放进移动端列表惯用的圆角底块里。
 */
export default function FileEntryIcon({ entry }: { entry: SftpFileEntry }) {
  const badge = entryBadge(entry);
  return (
    <span
      data-kind={badge.toLowerCase()}
      className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-surface-raised"
      aria-hidden
    >
      {badge === 'DIR' ? (
        <svg
          className="h-5 w-5 text-yellow-500"
          fill="currentColor"
          viewBox="0 0 24 24"
        >
          <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
        </svg>
      ) : badge === 'LINK' ? (
        <svg
          className="h-5 w-5 text-cyan-500"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
          />
        </svg>
      ) : (
        <svg
          className="h-5 w-5 text-fg-tertiary"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
      )}
    </span>
  );
}
