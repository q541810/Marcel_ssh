import { useState } from 'react';
import { X } from 'lucide-react';
import type { AgentAttachments } from '@/hooks/useAgentAttachments';
import AttachmentStrip from './AttachmentStrip';
import AttachmentPreview from './AttachmentPreview';

interface Props {
  attachments: AgentAttachments;
  mobile?: boolean;
}

/** 输入区只展示附件及读取反馈；完整文件正文留在 manager 中直到发送。 */
export default function DraftAttachments({ attachments, mobile = false }: Props) {
  const [preview, setPreview] = useState<{ draftKey: string; id: string } | null>(null);
  const item = preview?.draftKey === attachments.draftKey
    ? attachments.items.find((entry) => entry.id === preview.id) ?? null
    : null;
  const blockedReason = attachments.items.length > 0 || attachments.sendUnavailableReason || attachments.sending
    ? attachments.sendBlockedReason : null;
  const notice = attachments.notice === blockedReason ? null : attachments.notice;

  return <>
    {(attachments.items.length > 0 || blockedReason) && (
      <div className="mb-2 min-w-0">
        <AttachmentStrip
          items={attachments.items}
          mobile={mobile}
          onPreview={(id) => setPreview({ draftKey: attachments.draftKey, id })}
          onRemove={attachments.remove}
          onRetry={(id) => { void attachments.retry(id); }}
        />
        {blockedReason && (
          <p role="status" className="mt-1.5 px-1 text-xs leading-relaxed text-zinc-300">{blockedReason}</p>
        )}
      </div>
    )}
    {notice && (
      <div role="status" className="mb-2 flex min-w-0 items-center gap-1 rounded-lg border border-amber-800/50 bg-amber-950/60 pl-2.5 text-xs leading-relaxed text-amber-200">
        <span className="min-w-0 flex-1 break-words py-2">{notice}</span>
        <button
          type="button"
          aria-label="关闭附件提示"
          onClick={attachments.dismissNotice}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-amber-900/30 active:bg-amber-900/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400"
        ><X aria-hidden="true" className="h-4 w-4" /></button>
      </div>
    )}
    <AttachmentPreview item={item} mobile={mobile} onClose={() => setPreview(null)} />
  </>;
}
