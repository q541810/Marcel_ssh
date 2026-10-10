/** 图片展示不拥有来源：SFTP 临时文件由读取层回收，本地 URL 由调用方保管。 */
export type ImagePreviewSource =
  | { kind: 'sftp'; sessionId: string; filePath: string }
  | { kind: 'local'; src: string; fallbackSrc?: string };

/** 文件管理器与 Agent 附件使用同一组平台预览入口。 */
export interface ImagePreviewProps {
  open: boolean;
  source: ImagePreviewSource;
  fileName: string;
  /** 历史附件可能没有大小信息；缺失时不展示大小。 */
  fileSize?: number;
  onClose: () => void;
}
