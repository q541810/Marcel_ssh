import { useState, useCallback, useRef, useMemo } from 'react';
import PasswordPrompt from '@/components/connection/PasswordPrompt';

interface PromptConfig {
  title: string;
  description: string;
  allowRemember?: boolean;
  onSubmit: (password: string, remember: boolean) => void;
}

export function useConnectWithPassword() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [allowRemember, setAllowRemember] = useState(false);
  const onSubmitRef = useRef<((password: string, remember: boolean) => void) | null>(null);

  const prompt = useCallback((config: PromptConfig) => {
    setTitle(config.title);
    setDescription(config.description);
    setAllowRemember(config.allowRemember ?? false);
    onSubmitRef.current = config.onSubmit;
    setOpen(true);
  }, []);

  const dismiss = useCallback(() => {
    setOpen(false);
  }, []);

  const handleSubmit = useCallback((password: string, remember: boolean) => {
    setOpen(false);
    onSubmitRef.current?.(password, remember);
  }, []);

  const Prompt = useMemo(() => (
    <PasswordPrompt
      open={open}
      title={title}
      description={description}
      allowRemember={allowRemember}
      onSubmit={handleSubmit}
      onCancel={dismiss}
    />
  ), [open, title, description, allowRemember, handleSubmit, dismiss]);

  return { prompt, dismiss, Prompt };
}
