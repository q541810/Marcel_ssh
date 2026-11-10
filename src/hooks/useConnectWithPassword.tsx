import { useState, useCallback, useRef, useMemo } from 'react';
import PasswordPrompt from '@/components/connection/PasswordPrompt';
import { getErrorMessage } from '@/lib/errors';
import type { CredentialPrompt } from '@/lib/connectionAuth';

type PromptConfig = CredentialPrompt;

/**
 * 驱动「输入密码 / 密钥密码」这一个浮层。
 *
 * 没有「记住」选项：调用方拿到的凭证一律存进系统密钥链（见 PasswordPrompt 的注释）。
 */
export function useConnectWithPassword() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const revisionRef = useRef(0);
  const submitting = useRef(false);
  const onSubmitRef = useRef<PromptConfig['onSubmit'] | null>(null);

  const prompt = useCallback((config: PromptConfig) => {
    setTitle(config.title);
    setDescription(config.description);
    onSubmitRef.current = config.onSubmit;
    setRevision(++revisionRef.current);
    setError(config.error);
    setBusy(false);
    submitting.current = false;
    setOpen(true);
  }, []);

  const dismiss = useCallback(() => {
    if (submitting.current) return;
    onSubmitRef.current = null;
    setOpen(false);
  }, []);

  const handleSubmit = useCallback(async (password: string) => {
    if (submitting.current) return;
    const currentRevision = revisionRef.current;
    submitting.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await onSubmitRef.current?.(password);
      if (currentRevision === revisionRef.current) {
        onSubmitRef.current = null;
        setOpen(false);
      }
    } catch (err) {
      if (currentRevision === revisionRef.current) setError(getErrorMessage(err));
    } finally {
      if (currentRevision === revisionRef.current) {
        submitting.current = false;
        setBusy(false);
      }
    }
  }, []);

  const Prompt = useMemo(() => (
    <PasswordPrompt
      open={open}
      title={title}
      description={description}
      error={error}
      busy={busy}
      revision={revision}
      onSubmit={handleSubmit}
      onCancel={dismiss}
    />
  ), [open, title, description, error, busy, revision, handleSubmit, dismiss]);

  return { prompt, dismiss, Prompt };
}
