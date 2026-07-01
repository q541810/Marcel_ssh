import { useState, useEffect, useRef } from 'react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';

interface Props {
  open: boolean;
  title?: string;
  description?: string;
  /** When true, show a "记住密码" checkbox. */
  allowRemember?: boolean;
  /** Label for the submit button. Defaults to "连接". */
  submitLabel?: string;
  onSubmit: (password: string, remember: boolean) => void;
  onCancel: () => void;
}

/**
 * Modal that asks the user to enter a password.
 * Used for SSH password authentication.
 */
export default function PasswordPrompt({
  open,
  title = '请输入密码',
  description,
  allowRemember = false,
  submitLabel = '连接',
  onSubmit,
  onCancel,
}: Props) {
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setPassword('');
      setRemember(false);
      // Focus the input on next tick after Modal mounts
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(password, remember);
  };

  return (
    <Modal open={open} onClose={onCancel} title={title}>
      <form onSubmit={handleSubmit} className="p-4 space-y-4">
        {description && (
          <p className="text-sm text-zinc-400">{description}</p>
        )}
        <input
          ref={inputRef}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          className="w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500"
          placeholder="密码"
        />
        {allowRemember && (
          <label className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="w-4 h-4 accent-indigo-500"
            />
            记住密码（保存到系统密钥链）
          </label>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" type="button" onClick={onCancel}>
            取消
          </Button>
          <Button variant="primary" type="submit" disabled={!password}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
