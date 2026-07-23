import { useEffect, useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import { useQuickCommandStore } from '@/stores/quickCommandStore';
import {
  resolveMobileQuickCommands,
  toExecutableQuickCommand,
  type MobileQuickCommand,
} from './quickCommands';

interface MobileQuickCommandBarProps {
  /** Override list (tests / custom). Default: store + fallback defaults. */
  commands?: readonly MobileQuickCommand[];
  /** Saved-connection id for per-host quick commands when available. */
  sessionKey?: string | null;
  /** Live session id — required to execute through the store. */
  sessionId: string | null;
  /** Reload store on re-show — settings management may have loaded global-only. */
  visible?: boolean;
  onError?: (message: string) => void;
}

export default function MobileQuickCommandBar({
  commands: commandsProp,
  sessionKey = null,
  sessionId,
  visible = true,
  onError,
}: MobileQuickCommandBarProps) {
  const storeCommands = useQuickCommandStore((s) => s.commands);
  const executingId = useQuickCommandStore((s) => s.executingId);
  const load = useQuickCommandStore((s) => s.load);
  const execute = useQuickCommandStore((s) => s.execute);

  useEffect(() => {
    if (commandsProp || !visible) return;
    void load(sessionKey);
  }, [commandsProp, load, sessionKey, visible]);

  const commands = useMemo(
    () => commandsProp ?? resolveMobileQuickCommands(storeCommands),
    [commandsProp, storeCommands],
  );

  const handleRun = (cmd: MobileQuickCommand) => {
    if (!sessionId || executingId) return;
    void execute(toExecutableQuickCommand(cmd), sessionId).catch((err) => {
      onError?.(err instanceof Error ? err.message : String(err));
    });
  };

  if (commands.length === 0) return null;

  return (
    <div className="flex flex-shrink-0 gap-1.5 overflow-x-auto border-t border-zinc-800 bg-zinc-900/80 px-2 py-1.5 [scrollbar-width:none]">
      {commands.map((cmd) => {
        const running = executingId === cmd.id;
        return (
          <button
            key={cmd.id}
            type="button"
            // Don't steal focus from the terminal (keeps soft keyboard open).
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handleRun(cmd)}
            disabled={!sessionId || (executingId != null && !running)}
            className={`flex flex-shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors duration-100 active:scale-95 disabled:opacity-50 ${
              running
                ? 'border-green-500 bg-green-500/15 text-green-300'
                : 'border-zinc-700 bg-zinc-800 text-zinc-200 active:bg-zinc-700'
            }`}
          >
            {running && <Loader2 className="h-3 w-3 animate-spin" />}
            {cmd.label}
            {cmd.lines.length > 1 && (
              <span className="text-[10px] text-zinc-500">
                ×{cmd.lines.length}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
