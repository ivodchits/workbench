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
//
// Restore can't assume the content is already there: a genuine remount (switching
// projects swaps the whole dock via `fromJSON`) shows the panel *before* its buffer
// has loaded — the editor re-reads files from disk asynchronously, so the preview
// first renders empty and only grows tall enough to scroll a beat later. The
// intersection fires against that empty render, so a one-shot restore finds nothing
// to scroll and gives up. A ResizeObserver on the content closes the gap: while a
// restore is still pending, every growth of the scrollable content re-tries it until
// the saved offset finally sticks.

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
  // A restore was requested but the content wasn't tall enough to honor it yet — so
  // keep re-trying on content growth until it lands.
  let pending = false;

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

  // Try the restore; if it can't land yet (content still loading / sizing), arm the
  // ResizeObserver path to retry as the content grows.
  const tryRestore = () => {
    pending = !apply();
  };

  const io = new IntersectionObserver((entries) => {
    if (!entries[entries.length - 1]?.isIntersecting) return;
    // The element may still be settling its size on re-attach; retry next frame too.
    tryRestore();
    if (pending) requestAnimationFrame(tryRestore);
  });

  // The scrollable content can mount/grow after the panel is shown (async buffer
  // load on a project swap). Re-try the pending restore whenever it resizes, then
  // stand down once it sticks. Observe the content children (their box reflects the
  // full content height, which `el`'s own box does not) and keep that observation
  // current as React swaps children in.
  const ro = new ResizeObserver(() => {
    if (pending) tryRestore();
  });
  const observeContent = () => {
    for (const child of Array.from(el.children)) ro.observe(child);
  };
  observeContent();
  const mo = new MutationObserver(observeContent);
  mo.observe(el, { childList: true });

  el.addEventListener("scroll", onScroll, { passive: true });
  io.observe(el);

  return () => {
    el.removeEventListener("scroll", onScroll);
    io.disconnect();
    ro.disconnect();
    mo.disconnect();
  };
}
