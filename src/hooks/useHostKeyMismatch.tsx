import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import HostKeyMismatchModal from '@/components/connection/HostKeyMismatchModal';
import type { HostKeyMismatchData } from '@/lib/types';
import { registerBackHandler } from '@/mobile/backHandler';

interface PromptConfig {
  data: HostKeyMismatchData;
  onTrust: () => void | Promise<void>;
}

/**
 * Drives the {@link HostKeyMismatchModal}. Mirrors the `useConnectWithPassword`
 * pattern: caller catches a connect error, calls `prompt({ data, onTrust })`
 * when it's a host-key mismatch, and renders `{ Modal }` in its component.
 *
 * `onTrust` is invoked when the user opts to trust the new key. The caller is
 * responsible for re-issuing the connect/reconnect call with
 * `trustNewHostKey=true` inside `onTrust`.
 */
export function useHostKeyMismatch() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<HostKeyMismatchData | null>(null);
  const onTrustRef = useRef<(() => void | Promise<void>) | null>(null);

  const prompt = useCallback((config: PromptConfig) => {
    setData(config.data);
    onTrustRef.current = config.onTrust;
    setOpen(true);
  }, []);

  const cancel = useCallback(() => {
    setOpen(false);
    onTrustRef.current = null;
  }, []);

  // Android back gesture cancels the prompt (same as the cancel button).
  // Harmless on desktop: the handler stack is only consulted by the Android
  // activity's back dispatcher.
  useEffect(() => {
    if (!open) return;
    return registerBackHandler(cancel);
  }, [open, cancel]);

  const handleTrust = useCallback(async () => {
    const cb = onTrustRef.current;
    setOpen(false);
    onTrustRef.current = null;
    if (cb) await cb();
  }, []);

  const Modal = useMemo(() => (
    <HostKeyMismatchModal
      open={open}
      data={data}
      onTrust={handleTrust}
      onCancel={cancel}
    />
  ), [open, data, handleTrust, cancel]);

  return { prompt, cancel, Modal };
}