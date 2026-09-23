import { useState, useCallback, useRef, useMemo } from 'react';
import PasswordPrompt from '@/components/connection/PasswordPrompt';

interface PromptConfig {
  title: string;
  description: string;
  onSubmit: (password: string) => void;
}

/**
 * 驱动「输入密码 / 密钥密码」这一个浮层。
 *
 * 没有「记住」选项：调用方拿到的凭证一律存进系统密钥链（见 PasswordPrompt 的注释）。
 */
export function useConnectWithPassword() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const onSubmitRef = useRef<((password: string) => void) | null>(null);

  const prompt = useCallback((config: PromptConfig) => {
    setTitle(config.title);
    setDescription(config.description);
    onSubmitRef.current = config.onSubmit;
    setOpen(true);
  }, []);

  const dismiss = useCallback(() => {
    setOpen(false);
  }, []);

  const handleSubmit = useCallback((password: string) => {
    setOpen(false);
    onSubmitRef.current?.(password);
  }, []);

  const Prompt = useMemo(() => (
    <PasswordPrompt
      open={open}
      title={title}
      description={description}
      onSubmit={handleSubmit}
      onCancel={dismiss}
    />
  ), [open, title, description, handleSubmit, dismiss]);

  return { prompt, dismiss, Prompt };
}
