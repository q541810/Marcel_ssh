import type { HostKeyMismatchData } from '@/lib/types';

/**
 * Best-effort extraction of a human-readable message from anything thrown by
 * Tauri invoke (string, Error, or structured `{ kind, message, data? }`).
 */
export function getErrorMessage(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === 'string') return obj.message;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return '未知错误';
  }
}

export interface ParsedAppError {
  kind: string;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Parse a Tauri command error into its structured `{ kind, message, data }`
 * form. The Rust side serialises `AppError` this way (see error.rs) so the
 * frontend can branch on `kind` without string parsing.
 *
 * Returns `{ kind: 'Other', message }` if the error isn't in the expected
 * shape (e.g. a bare string or an `Error` thrown outside Tauri).
 */
export function parseAppError(err: unknown): ParsedAppError {
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    if (typeof obj.kind === 'string' && typeof obj.message === 'string') {
      const data =
        obj.data && typeof obj.data === 'object'
          ? obj.data as Record<string, unknown>
          : undefined;
      return { kind: obj.kind, message: obj.message, data };
    }
  }
  return { kind: 'Other', message: getErrorMessage(err) };
}

/** Narrow a parsed AppError to a HostKeyMismatchData, or null if it isn't one. */
export function asHostKeyMismatch(e: ParsedAppError): HostKeyMismatchData | null {
  if (e.kind !== 'HostKeyMismatch' || !e.data) return null;
  const d = e.data as Partial<HostKeyMismatchData>;
  if (
    typeof d.host !== 'string' ||
    typeof d.port !== 'number' ||
    typeof d.storedAlgorithm !== 'string' ||
    typeof d.storedFingerprint !== 'string' ||
    typeof d.presentedAlgorithm !== 'string' ||
    typeof d.presentedFingerprint !== 'string'
  ) {
    return null;
  }
  return d as HostKeyMismatchData;
}