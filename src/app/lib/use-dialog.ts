import { useEffect, useRef, type RefObject } from "react";

let openDialogs = 0;
let previousOverflow = "";
const dialogStack: HTMLElement[] = [];
const focusableSelector =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]';

/** Keep touch scrolling and keyboard focus in the topmost open dialog. */
export const useDialog = (
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  enabled = true,
) => {
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    if (openDialogs++ === 0) {
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    dialogStack.push(element);
    const getFocusable = () =>
      [...element.querySelectorAll<HTMLElement>(focusableSelector)].filter(
        (node) => node.getClientRects().length > 0 && !node.closest("[inert]"),
      );
    (getFocusable()[0] ?? element).focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (dialogStack.at(-1) !== element) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
      } else if (event.key === "Tab") {
        const controls = getFocusable();
        const first = controls[0],
          last = controls.at(-1);
        if (!first) {
          event.preventDefault();
          element.focus();
        } else if (
          event.shiftKey &&
          (document.activeElement === first || !element.contains(document.activeElement))
        ) {
          event.preventDefault();
          last?.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || !element.contains(document.activeElement))
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      dialogStack.splice(dialogStack.indexOf(element), 1);
      if (--openDialogs === 0) document.body.style.overflow = previousOverflow;
      queueMicrotask(() => {
        const topDialog = dialogStack.at(-1);
        if (
          previousFocus?.isConnected &&
          !previousFocus.closest("[inert]") &&
          (!topDialog || topDialog.contains(previousFocus))
        ) {
          previousFocus.focus({ preventScroll: true });
        } else if (
          topDialog &&
          !topDialog.closest("[inert]") &&
          !topDialog.contains(document.activeElement)
        ) {
          const target = [...topDialog.querySelectorAll<HTMLElement>(focusableSelector)].find(
            (node) => node.getClientRects().length > 0 && !node.closest("[inert]"),
          );
          (target ?? topDialog).focus({ preventScroll: true });
        }
      });
    };
  }, [enabled, ref]);
};
