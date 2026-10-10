import { useLayoutEffect, useRef, type RefObject } from 'react';

interface Options {
  open: boolean;
  mobile?: boolean;
  dialogRef: RefObject<HTMLElement>;
  initialFocusRef: RefObject<HTMLElement>;
  onClose: () => void;
}

/** 图片与文本预览共用焦点约定，关闭手机预览时不重新唤起键盘。 */
export function usePreviewDialogFocus({
  open,
  mobile = false,
  dialogRef,
  initialFocusRef,
  onClose,
}: Options) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    if (!open) return;
    const content = dialogRef.current;
    const dialog = content?.closest<HTMLElement>('[role="dialog"]') ?? content;
    if (!dialog) return;
    const originalFocus = document.activeElement;
    const focusable = () =>
      [
        ...dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]',
        ),
      ].filter(
        (node) => !node.closest('[hidden], [inert], [aria-hidden="true"]'),
      );
    const focusInside = () => {
      (initialFocusRef.current ?? focusable()[0] ?? dialog).focus({
        preventScroll: true,
      });
    };
    focusInside();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
      } else if (event.key === 'Tab') {
        const nodes = focusable();
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (!first || !last) {
          event.preventDefault();
          focusInside();
          return;
        }
        const outside = !dialog.contains(document.activeElement);
        if (event.shiftKey && (document.activeElement === first || outside)) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || outside)
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target))
        focusInside();
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocus);
      if (
        originalFocus instanceof HTMLElement &&
        originalFocus.isConnected &&
        originalFocus !== document.body &&
        (!mobile ||
          (originalFocus.tagName !== 'TEXTAREA' &&
            originalFocus.tagName !== 'INPUT' &&
            !originalFocus.isContentEditable))
      )
        originalFocus.focus({ preventScroll: true });
    };
  }, [open, mobile, dialogRef, initialFocusRef]);
}
