import Modal from './ui/Modal';

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function HelpModal({ open, onClose }: Props) {
  return (
    <Modal open={open} onClose={onClose} title="终端使用指南">
      <div className="px-4 py-3 text-sm text-zinc-300 space-y-2">
        <p>
          <span className="text-zinc-100 font-medium">Ctrl+C 正常执行：</span>
          直接按下 Ctrl+C，按照 SSH 逻辑正常执行命令中断操作。
        </p>
        <p>
          <span className="text-zinc-100 font-medium">Ctrl+C 复制：</span>
          先用鼠标框选要复制的文字，然后再按 Ctrl+C，按照 Windows 逻辑执行复制操作。
        </p>
        <p>
          <span className="text-zinc-100 font-medium">右键粘贴：</span>
          在终端区域右键点击，默认执行粘贴操作。
        </p>
      </div>
    </Modal>
  );
}
