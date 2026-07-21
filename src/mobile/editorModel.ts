export type SaveAction = 'save' | 'conflict';

/**
 * Decide whether to save straight away or ask the user about an external change.
 * `remoteMtime` is null when the mtime probe failed for a non-fatal reason —
 * we proceed with the save attempt (same policy as the desktop editor).
 */
export function decideSaveAction(
  remoteMtime: number | null,
  loadedMtime: number,
): SaveAction {
  if (remoteMtime == null) return 'save';
  return remoteMtime === loadedMtime ? 'save' : 'conflict';
}

/** Whether an error message means the remote file no longer exists. */
export function isFileMissingMessage(message: string): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes('no such file') ||
    lower.includes('not found') ||
    message.includes('不存在')
  );
}
