// A small modal overlay styled as a box-drawing `Panel` (§5.x). Used by the
// project registry for the add/edit form and the remove confirmation. Closes on
// backdrop click and Escape; the body is a normal `Panel` so it reads as part of
// the same terminal surface rather than a foreign dialog.
//
// Because these dialogs are often summoned by a keyboard chord (e.g. Ctrl+Shift+K
// to kill an instance), focus would otherwise stay on the xterm terminal and the
// dialog couldn't receive keystrokes. So on open the modal steals focus into its
// first focusable control, traps Tab within the dialog, and restores focus to the
// previously-focused element when it closes.

import { useEffect, useRef, type ReactNode } from "react";
import Panel from "../../theme/Panel";

interface ModalProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

function Modal({ title, onClose, children, width = 460 }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Steal focus on open and restore it on close. Capturing the previously-focused
  // element lets us hand control back to the terminal/rail when the dialog closes.
  useEffect(() => {
    const prevFocused = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const first = dialog?.querySelector<HTMLElement>(FOCUSABLE);
    // Fall back to the dialog container (tabIndex -1) when it holds no focusable
    // control, so keystrokes still land here rather than in the terminal.
    (first ?? dialog)?.focus();
    return () => prevFocused?.focus?.();
  }, []);

  return (
    <div
      onMouseDown={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(8,9,13,0.62)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Escape closes; handled here (not a window listener) so it only fires
          // while focus is inside the dialog, and never reaches the terminal.
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
            return;
          }
          // Trap Tab within the dialog so it can't wander back to the terminal.
          if (e.key === "Tab") {
            const items = Array.from(
              dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
            );
            if (items.length === 0) {
              e.preventDefault();
              return;
            }
            const first = items[0];
            const last = items[items.length - 1];
            const active = document.activeElement as HTMLElement | null;
            if (e.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && active === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
        style={{ width, maxWidth: "92vw", outline: "none" }}
      >
        <Panel title={title} accent bodyStyle={{ padding: "18px 18px 16px" }}>
          {children}
        </Panel>
      </div>
    </div>
  );
}

export default Modal;
