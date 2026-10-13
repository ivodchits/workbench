// A one-line, self-dismissing notice at the bottom of the window — feedback for a
// command that has no surface of its own (e.g. "copy last response" run from the
// palette). Plain DOM, so it works in the main window and in torn-off ones alike.

const SHOW_MS = 1800;

let current: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

export function flash(message: string): void {
  current?.remove();
  clearTimeout(timer);
  const node = document.createElement("div");
  node.setAttribute("role", "status");
  node.textContent = message;
  Object.assign(node.style, {
    position: "fixed",
    left: "50%",
    bottom: "44px",
    transform: "translateX(-50%)",
    zIndex: "9999",
    padding: "5px 12px",
    font: "11.5px var(--wb-mono)",
    color: "var(--wb-text)",
    background: "var(--wb-panel)",
    border: "1px solid var(--wb-borderActive)",
    pointerEvents: "none",
  });
  document.body.appendChild(node);
  current = node;
  timer = setTimeout(() => {
    node.remove();
    if (current === node) current = null;
  }, SHOW_MS);
}
