import { useMemo, useState } from 'react';
import type { UserTextAttachment } from '@/lib/types';
import type { AttachmentItem } from '@/stores/agentDraftStore';
import AttachmentStrip from './AttachmentStrip';
import AttachmentPreview from './AttachmentPreview';
import MessageImageThumb from './MessageImageThumb';

interface Props {
  files: readonly UserTextAttachment[];
  imagePaths: readonly string[];
  mobile: boolean;
}

/** 已发送与历史消息复用本地附件预览，不触发 SSH 读取。 */
export default function UserMessageAttachments({ files, imagePaths, mobile }: Props) {
  const [preview, setPreview] = useState<AttachmentItem | null>(null);
  const items = useMemo<AttachmentItem[]>(() => files.map((file) => ({
    ...file, kind: 'text', status: 'ready',
  })), [files]);

  return <>
    {imagePaths.length > 0 && (
      <div className="mb-1.5 flex max-w-full flex-wrap justify-end gap-1.5">
        {imagePaths.map((path, index) => (
          <MessageImageThumb
            key={path}
            relativePath={path}
            label={`图片 ${index + 1}`}
            className="h-16 w-16"
            onPreview={(src) => setPreview({
              id: path, name: `图片 ${index + 1}`, kind: 'image', status: 'ready', previewUrl: src,
            })}
          />
        ))}
      </div>
    )}
    {items.length > 0 && (
      <div className="mb-1.5 w-full min-w-0 max-w-full">
        <AttachmentStrip items={items} mobile={mobile} onPreview={(id) => setPreview(items.find((item) => item.id === id) ?? null)} />
      </div>
    )}
    <AttachmentPreview item={preview} mobile={mobile} onClose={() => setPreview(null)} />
  </>;
}
