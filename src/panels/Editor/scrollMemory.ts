// Remembers an element's scroll offset across dockview tab switches.
//
// Dockview keeps a panel's React tree mounted when you switch tabs, but it detaches
// and re-attaches the panel's DOM — and re-attaching an element to the document
// resets its scrollTop to 0. That reset fires no scroll event and no React
// lifecycle, so neither a mount-time restore nor a scroll handler ever sees it. An
// IntersectionObserver does: the element stops intersecting while the tab is hidden
// (detached / display:none) and intersects again when shown, which is exactly when
// we re-apply the saved offset. A scroll listener keeps that offset current.
//
// The offsets outlive any single element (keyed by a stable per-view id the caller
// supplies), so a genuine unmount/remount round-trips through the same map. Used by
// the markdown preview and the CodeMirror editor; the pooled terminal has its own
// re-sync (its scroll lives in xterm's buffer model, not a DOM scrollTop).

const offsets = new Map<string, number>();

/**
 * Persist and restore `el`'s scrollTop under `key` across dockview tab switches.
 * Returns a cleanup that detaches the listener and observer.
 */
export function persistScroll(el: HTMLElement, key: string): () => void {
  // Suppresses the scroll handler while we re-apply the offset, so the programmatic
  // write (and any transient clamp while the element is still sizing) can't be
  // mistaken for a user scroll and overwrite the saved value.
  let restoring = false;

  const onScroll = () => {
    // Ignore events fired while we're restoring or while the element has no layout
    // (a collapse during a tab switch clamps scrollTop to 0).
    if (restoring || !el.clientHeight) return;
    offsets.set(key, el.scrollTop);
  };

  const apply = (): boolean => {
    const target = offsets.get(key) ?? 0;
    if (target === 0) return true; // nothing to restore
    if (!el.clientHeight || el.scrollHeight <= el.clientHeight) return false;
    restoring = true;
    el.scrollTop = target;
    restoring = false;
    return el.scrollTop > 0; // false if the write clamped back to the top
  };

  const io = new IntersectionObserver((entries) => {
    if (!entries[entries.length - 1]?.isIntersecting) return;
    // The element may still be settling its size on re-attach; retry next frame.
    if (!apply()) requestAnimationFrame(apply);
  });

  el.addEventListener("scroll", onScroll, { passive: true });
  io.observe(el);

  return () => {
    el.removeEventListener("scroll", onScroll);
    io.disconnect();
  };
}
