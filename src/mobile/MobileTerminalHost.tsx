import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { CanvasAddon } from '@xterm/addon-canvas';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { useSessionStore } from '@/stores/sessionStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useHostKeyMismatch } from '@/hooks/useHostKeyMismatch';
import { useSessionLifecycle } from '@/hooks/useSessionLifecycle';
import { useAnimatedPresence } from '@/hooks/useAnimatedPresence';
import * as tauri from '@/lib/tauri';
import { openExternalLink } from '@/lib/externalLinks';
import {
  asHostKeyMismatch,
  getErrorMessage,
  parseAppError,
} from '@/lib/errors';
import MobileAuxKeyBar from './MobileAuxKeyBar';
import MobileConnectionList from './MobileConnectionList';
import MobileQuickCommandBar from './MobileQuickCommandBar';
import MobileSessionHeader from './MobileSessionHeader';
import MobilePasteConfirmSheet from './ui/MobilePasteConfirmSheet';
import { registerBackHandler } from './backHandler';
import {
  applyCtrlToggle,
  createInputBatcher,
  formatDisconnectBanner,
  needsPasteConfirmation,
  resolveAuxKeyInput,
  resolveDisconnectBannerKind,
  type AuxKeyId,
  type InputBatcher,
  type TerminalInputState,
} from './terminalInput';
import { resolveTerminalPanelMode } from './sessionUi';
import { resolveTerminalAppearance } from './mobileSettingsModel';
import { attachXtermMomentumScroll } from './terminalMomentum';
import { attachTouchSelection } from './terminalSelection';
import { attachTapLocate } from './terminalTapLocate';

interface MobileTerminalHostProps {
  /** When false, host stays mounted but hidden (tab keep-alive). */
  visible?: boolean;
}

export default function MobileTerminalHost({
  visible = true,
}: MobileTerminalHostProps) {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const disconnect = useSessionStore((s) => s.disconnect);
  const reconnect = useSessionStore((s) => s.reconnect);
  const storeSettings = useSettingsStore((s) => s.settings);
  const preview = useSettingsStore((s) => s.preview);
  const appearance = useMemo(
    () => resolveTerminalAppearance(storeSettings, preview),
    [storeSettings, preview],
  );
  const hostKeyMismatch = useHostKeyMismatch();
  const { onDisconnected } = useSessionLifecycle();

  const [forceList, setForceList] = useState(false);
  const [inputState, setInputState] = useState<TerminalInputState>({
    ctrlActive: false,
  });
  const [ioError, setIoError] = useState<string | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyHint, setCopyHint] = useState(false);
  const [pendingPaste, setPendingPaste] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const inputStateRef = useRef(inputState);
  const inputBatcherRef = useRef<InputBatcher | null>(null);
  const activeSessionIdRef = useRef(activeSessionId);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const boundSessionIdRef = useRef<string | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Prevents duplicate disconnect banners for the same disconnect cycle (desktop parity). */
  const disconnectBannerShownRef = useRef(false);

  inputStateRef.current = inputState;
  activeSessionIdRef.current = activeSessionId;

  const hasAnySession = Object.keys(sessions).length > 0;
  const activeSession = activeSessionId
    ? (sessions[activeSessionId] ?? null)
    : null;
  const panelMode = forceList
    ? 'list'
    : resolveTerminalPanelMode(sessions, activeSessionId);
  const showList = panelMode === 'list';
  const listPresence = useAnimatedPresence(showList);
  const isLive = activeSession?.status === 'connected';

  useEffect(() => {
    if (
      forceList &&
      activeSession &&
      (activeSession.status === 'connecting' ||
        activeSession.status === 'connected')
    ) {
      setForceList(false);
    }
  }, [forceList, activeSession]);

  // Android back gesture leaves the forced connection-list overlay.
  useEffect(() => {
    if (!forceList) return;
    return registerBackHandler(() => setForceList(false));
  }, [forceList]);

  // xterm stays for host lifetime (tab keep-alive). List is overlay; container always laid out.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const initial = resolveTerminalAppearance(
      useSettingsStore.getState().settings,
      useSettingsStore.getState().preview,
    );
    const term = new Terminal({
      cursorBlink: true,
      fontSize: initial.fontSize,
      fontFamily: initial.fontFamily,
      theme: initial.terminalColors,
      allowProposedApi: true,
      scrollback: 10000,
      disableStdin: false,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    // Clickable URLs, same handler as desktop (TerminalInstanceManager).
    term.loadAddon(new WebLinksAddon((_event, uri) => openExternalLink(uri)));
    term.open(el);
    // Canvas renderer is mandatory on mobile: the default DOM renderer
    // rebuilds every row's spans on each render, which removes the touch
    // target mid-gesture — the WebView then fires touchcancel and scroll
    // dies whenever the finger rests on text (blank areas hit persistent
    // row divs, so they scrolled fine).
    term.loadAddon(new CanvasAddon());
    try {
      fitAddon.fit();
    } catch {
      /* hidden */
    }

    // xterm touch has no fling; add lift-off inertia via scrollLines.
    const momentum = attachXtermMomentumScroll({
      container: el,
      getTerminal: () => termRef.current,
    });

    // xterm selection is mouse-driven; add long-press word select + drag.
    const touchSelection = attachTouchSelection({
      container: el,
      getTerminal: () => termRef.current,
      onSelectionComplete: () => {
        setCopyHint(true);
        if (copyHintTimerRef.current) clearTimeout(copyHintTimerRef.current);
        copyHintTimerRef.current = setTimeout(() => {
          copyHintTimerRef.current = null;
          setCopyHint(false);
        }, 2800);
      },
    });

    // Fast typing on Android: one invoke per keystroke is a full
    // WebView→Java→Rust roundtrip that saturates the main thread and makes
    // the WebView drop IME commits (swallowed characters). Batch printable
    // text into one IPC call per tick; control chars flush immediately.
    const inputBatcher = createInputBatcher({
      flush: (payload) => {
        const sessionId = activeSessionIdRef.current;
        const session = sessionId
          ? useSessionStore.getState().sessions[sessionId]
          : null;
        if (!sessionId || session?.status !== 'connected') return;
        void tauri.sshSendInput(sessionId, payload).catch((err) => {
          setIoError(getErrorMessage(err));
        });
      },
    });
    inputBatcherRef.current = inputBatcher;

    // Tap the terminal to move the cursor within the current screen row
    // (arrow-key sequences to the remote shell). Cross-row taps are ignored:
    // ↑/↓ would hit shell history / program bindings.
    const tapLocate = attachTapLocate({
      container: el,
      getTerminal: () => termRef.current,
      onLocate: (seq) => inputBatcher.push(seq),
    });

    term.onData((data) => {
      let payload = data;
      let next = inputStateRef.current;
      if (data.length === 1) {
        const result = applyCtrlToggle(inputStateRef.current, data);
        payload = result.write;
        next = result.next;
      } else if (inputStateRef.current.ctrlActive) {
        next = { ctrlActive: false };
      }
      const prevCtrl = inputStateRef.current.ctrlActive;
      inputStateRef.current = next;
      if (next.ctrlActive !== prevCtrl) {
        // ctrlActive only drives the aux-bar Ctrl highlight; skipping the
        // setState when it did not change avoids a re-render per keystroke.
        setInputState(next);
      }
      inputBatcher.push(payload);
    });

    const selectionDisposable = term.onSelectionChange(() => {
      setHasSelection(term.hasSelection());
    });

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    const ro = new ResizeObserver(() => {
      try {
        fitAddon.fit();
        const sid = activeSessionIdRef.current;
        const sess = sid ? useSessionStore.getState().sessions[sid] : null;
        if (sid && sess?.status === 'connected') {
          void tauri.sshResize(sid, term.cols, term.rows).catch(() => {});
        }
      } catch {
        /* ignore fit when hidden */
      }
    });
    ro.observe(el);

    return () => {
      touchSelection.dispose();
      momentum.dispose();
      tapLocate.dispose();
      inputBatcher.dispose();
      inputBatcherRef.current = null;
      ro.disconnect();
      selectionDisposable.dispose();
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
      if (copiedTimerRef.current) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
      if (copyHintTimerRef.current) {
        clearTimeout(copyHintTimerRef.current);
        copyHintTimerRef.current = null;
      }
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      boundSessionIdRef.current = null;
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = appearance.fontSize;
    term.options.fontFamily = appearance.fontFamily;
    term.options.theme = appearance.terminalColors;
    requestAnimationFrame(() => {
      try {
        fitAddonRef.current?.fit();
        const sid = activeSessionIdRef.current;
        const sess = sid ? useSessionStore.getState().sessions[sid] : null;
        if (sid && sess?.status === 'connected') {
          void tauri.sshResize(sid, term.cols, term.rows).catch(() => {});
        }
      } catch {
        /* ignore */
      }
    });
  }, [appearance.fontSize, appearance.fontFamily, appearance.terminalColors]);

  // Bind SSH output listener to active session (keep across reconnect; wipe only on switch).
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const clearListener = () => {
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    };

    if (!activeSessionId || !activeSession) {
      clearListener();
      // Keep last bound id so the next connect still detects a session switch
      // and wipes stale scrollback (do not null out here).
      term.options.disableStdin = true;
      return;
    }

    const live = activeSession.status === 'connected';
    term.options.disableStdin = !live;

    if (!live) {
      // Drop buffered keystrokes on disconnect: the flush callback discards
      // them when not connected, so they can't leak into a reconnected session.
      inputBatcherRef.current?.flush();
    }

    if (boundSessionIdRef.current === activeSessionId) {
      if (live && visible && !showList) {
        try {
          fitAddonRef.current?.fit();
          void tauri
            .sshResize(activeSessionId, term.cols, term.rows)
            .catch(() => {});
          // No programmatic term.focus(): focusing the hidden xterm textarea
          // pops the soft keyboard. Keyboard opens only when the user taps
          // the terminal (xterm focuses itself on pointer down).
        } catch {
          /* ignore */
        }
      }
      return;
    }

    const prevBound = boundSessionIdRef.current;
    clearListener();
    if (prevBound != null) {
      term.reset();
    }
    boundSessionIdRef.current = activeSessionId;
    disconnectBannerShownRef.current = false;
    setIoError(null);

    let cancelled = false;
    void (async () => {
      try {
        const unlisten = await listen<string>(
          `ssh://output/${activeSessionId}`,
          (event) => {
            term.write(event.payload);
          },
        );
        if (cancelled || boundSessionIdRef.current !== activeSessionId) {
          unlisten();
          return;
        }
        unlistenRef.current = unlisten;
        if (live) {
          try {
            fitAddonRef.current?.fit();
            void tauri
              .sshResize(activeSessionId, term.cols, term.rows)
              .catch(() => {});
          } catch {
            /* ignore */
          }
          // No term.focus() here either — see the note above about the soft
          // keyboard.
        }
      } catch (err) {
        if (!cancelled) setIoError(getErrorMessage(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeSessionId, activeSession?.status, visible, showList]);

  // Disconnect banner in the xterm buffer (desktop parity: TerminalInstanceManager
  // showDisconnectBanner / prepareReconnect / onReconnected). Written into
  // scrollback so the break point stays visible when scrolling history.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !activeSession) return;
    if (boundSessionIdRef.current !== activeSessionId) return;

    const status = activeSession.status;
    if (status === 'connected' || status === 'connecting') {
      // Allow a new banner for the next disconnect cycle.
      disconnectBannerShownRef.current = false;
      return;
    }
    if (status !== 'disconnected' && status !== 'error') return;
    if (disconnectBannerShownRef.current) return;
    disconnectBannerShownRef.current = true;

    const kind = resolveDisconnectBannerKind(status, activeSession.errorMessage);
    try {
      term.write(formatDisconnectBanner(kind, activeSession.errorMessage ?? ''));
    } catch {
      /* term may be mid-dispose */
    }
  }, [activeSessionId, activeSession?.status, activeSession?.errorMessage]);

  // Refit when tab visible or leaving list overlay. Deliberately no
  // term.focus(): switching to this tab must not pop the soft keyboard.
  useEffect(() => {
    if (!visible || showList) return;
    const term = termRef.current;
    const fit = fitAddonRef.current;
    if (!term || !fit) return;
    requestAnimationFrame(() => {
      try {
        fit.fit();
        const sid = activeSessionIdRef.current;
        const sess = sid ? useSessionStore.getState().sessions[sid] : null;
        if (sid && sess?.status === 'connected') {
          void tauri.sshResize(sid, term.cols, term.rows).catch(() => {});
        }
      } catch {
        /* ignore */
      }
    });
  }, [visible, showList, panelMode]);

  const sendPayload = useCallback((payload: string) => {
    const sessionId = activeSessionIdRef.current;
    const session = sessionId
      ? useSessionStore.getState().sessions[sessionId]
      : null;
    if (!sessionId || session?.status !== 'connected') return;
    void tauri.sshSendInput(sessionId, payload).catch((err) => {
      setIoError(getErrorMessage(err));
    });
  }, []);

  const handleCopy = useCallback(() => {
    const term = termRef.current;
    if (!term || !term.hasSelection()) return;
    const text = term.getSelection();
    void writeText(text)
      .then(() => {
        term.clearSelection();
        setCopyHint(false);
        if (copyHintTimerRef.current) {
          clearTimeout(copyHintTimerRef.current);
          copyHintTimerRef.current = null;
        }
        setCopied(true);
        if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = setTimeout(() => {
          copiedTimerRef.current = null;
          setCopied(false);
        }, 1200);
      })
      .catch((err) => {
        setIoError(`复制失败：${getErrorMessage(err)}`);
      });
  }, []);

  const handleAuxKey = useCallback(
    (key: AuxKeyId) => {
      const result = resolveAuxKeyInput(inputStateRef.current, key);
      inputStateRef.current = result.next;
      setInputState(result.next);
      if (key === 'copy') {
        handleCopy();
        return;
      }
      if (key === 'paste') {
        void readText()
          .then((text) => {
            if (!text) return;
            if (needsPasteConfirmation(text)) {
              // Desktop parity: multi-line paste may execute commands — confirm first.
              setPendingPaste(text);
            } else {
              sendPayload(text);
            }
          })
          .catch((err) => {
            setIoError(`粘贴失败：${getErrorMessage(err)}`);
          });
      } else if (result.write != null) {
        sendPayload(result.write);
      }
      // No refocus of the terminal: aux-key buttons keep xterm focus via
      // onMouseDown preventDefault when the keyboard is open, and must not
      // summon the keyboard when it is closed.
    },
    [sendPayload, handleCopy],
  );

  const handleDisconnect = useCallback(
    (sessionId: string) => {
      const configId = useSessionStore.getState().sessions[sessionId]?.configId;
      void disconnect(sessionId).then(() => {
        if (configId) onDisconnected(configId);
      });
      setForceList(false);
    },
    [disconnect, onDisconnected],
  );

  const handleReconnect = useCallback(
    (sessionId: string) => {
      setIoError(null);
      void reconnect(sessionId).catch((err) => {
        const mismatch = asHostKeyMismatch(parseAppError(err));
        if (mismatch) {
          hostKeyMismatch.prompt({
            data: mismatch,
            onTrust: () => {
              void reconnect(sessionId, true).catch((reErr) => {
                setIoError(getErrorMessage(reErr));
              });
            },
          });
          return;
        }
        setIoError(getErrorMessage(err));
      });
    },
    [reconnect, hostKeyMismatch.prompt],
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-zinc-950">
      {listPresence.mounted && (
        <div
          onAnimationEnd={listPresence.onAnimationEnd}
          className={`absolute inset-0 z-10 ${
            listPresence.phase === 'exit'
              ? 'mobile-overlay-exit'
              : 'mobile-overlay-enter'
          }`}
        >
          <MobileConnectionList
            onBack={
              forceList && hasAnySession ? () => setForceList(false) : undefined
            }
          />
        </div>
      )}

      {!showList && (
        <MobileSessionHeader
          session={activeSession}
          onDisconnect={handleDisconnect}
          onReconnect={handleReconnect}
        />
      )}
      {hostKeyMismatch.Modal}

      {!showList && panelMode === 'connecting' && (
        <div className="flex-shrink-0 border-b border-amber-900/40 bg-amber-950/30 px-3 py-1.5 text-xs text-amber-200">
          正在连接…
        </div>
      )}
      {!showList && panelMode === 'error' && activeSession?.errorMessage && (
        <div className="flex-shrink-0 border-b border-red-900/40 bg-red-950/30 px-3 py-1.5 text-xs text-red-300">
          {activeSession.errorMessage}
        </div>
      )}
      {!showList && panelMode === 'disconnected' && (
        <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-xs text-zinc-400">
          <span>会话已断开{activeSession?.configId ? '，可点击重连' : ''}</span>
          <button
            type="button"
            onClick={() => setForceList(true)}
            className="flex-shrink-0 text-indigo-400 active:text-indigo-300"
          >
            连接列表
          </button>
        </div>
      )}
      {ioError && !showList && (
        <div className="flex-shrink-0 border-b border-red-900/40 bg-red-950/30 px-3 py-1.5 text-xs text-red-300">
          {ioError}
        </div>
      )}

      {/* Always in layout so xterm has real size; list overlay covers it when needed */}
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden px-1" />

      {!showList && (
        <>
          <MobileQuickCommandBar
            sessionKey={activeSession?.configId ?? null}
            sessionId={isLive ? activeSessionId : null}
            visible={visible}
            onError={setIoError}
          />
          {copyHint && hasSelection && !copied && (
            <div className="pointer-events-none flex-shrink-0 border-t border-indigo-500/30 bg-indigo-500/15 px-3 py-1.5 text-center text-[11px] text-indigo-200">
              已选中 · 点下方复制键复制
            </div>
          )}
          <MobileAuxKeyBar
            ctrlActive={inputState.ctrlActive}
            copyEnabled={hasSelection}
            copied={copied}
            onKey={handleAuxKey}
          />
          {!isLive && (
            <div className="pointer-events-none px-2 pb-1 text-center text-[10px] text-zinc-600">
              未连接时输入不会发送
            </div>
          )}
        </>
      )}

      {/* Multi-line paste guard (desktop parity: PasteConfirmDialog) */}
      <MobilePasteConfirmSheet
        text={pendingPaste}
        onConfirm={(text) => {
          setPendingPaste(null);
          sendPayload(text);
        }}
        onCancel={() => setPendingPaste(null)}
      />
    </div>
  );
}
