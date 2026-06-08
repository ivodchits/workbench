// A small modal overlay styled as a box-drawing `Panel` (§5.x). Used by the
// project registry for the add/edit form and the remove confirmation. Closes on
// backdrop click and Escape; the body is a normal `Panel` so it reads as part of
// the same terminal surface rather than a foreign dialog.

import { useEffect, type ReactNode } from "react";
import Panel from "../../theme/Panel";

interface ModalProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}

function Modal({ title, onClose, children, width = 460 }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
      <div onMouseDown={(e) => e.stopPropagation()} style={{ width, maxWidth: "92vw" }}>
        <Panel title={title} accent bodyStyle={{ padding: "18px 18px 16px" }}>
          {children}
        </Panel>
      </div>
    </div>
  );
}

export default Modal;
