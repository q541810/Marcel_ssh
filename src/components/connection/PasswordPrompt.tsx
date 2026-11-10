import { useState, useEffect, useRef } from 'react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { registerBackHandler } from '@/mobile/backHandler';

interface Props {
  open: boolean;
  title?: string;
  description?: string;
  /** Label for the submit button. Defaults to "连接". */
  submitLabel?: string;
  error?: string;
  busy?: boolean;
  revision?: number;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}

/**
 * Modal that asks the user to enter a password or a private-key passphrase.
 *
 * 这里**没有**「记住 / 不记住」的选项：输入的凭证一律由调用方存进系统密钥链。
 * 曾经有过那个复选框，而"没勾记住"这一条路能同时制造两个坏结果——每次连接都要重新
 * 输入，以及点标签上的「重连」只会得到一句"重连需要密码，请重新输入"（重连只从密钥链
 * 取凭证）。要清掉已保存的凭证，用连接设置里的「清除」，而不是靠当时不勾。
 */
export default function PasswordPrompt({
  open,
  title = '请输入密码',
  description,
  submitLabel = '连接',
  error,
  busy = false,
  revision = 0,
  onSubmit,
  onCancel,
}: Props) {
  const [password, setPassword] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setPassword('');
      // Focus the input on next tick after Modal mounts
      const timer = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(timer);
    }
  }, [open, revision]);

  useEffect(() => {
    if (open) return registerBackHandler(() => { if (!busy) onCancel(); });
  }, [open, busy, onCancel]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!busy && password) onSubmit(password);
  };

  return (
    <Modal open={open} onClose={onCancel} title={title} dismissible={!busy}>
      <form onSubmit={handleSubmit} className="p-4 space-y-4">
        {description && (
          <p className="text-read text-fg-secondary">{description}</p>
        )}
        <input
          ref={inputRef}
          type="password"
          aria-label={title}
          aria-invalid={!!error}
          disabled={busy}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          className="w-full rounded-lg field px-3 py-2 text-read text-fg"
          placeholder="密码"
        />
        {error && <p role="alert" className="text-body text-red-400">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" type="button" onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" type="submit" disabled={!password || busy}>
            {busy ? '正在验证…' : submitLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
