// Service worker for the Workbench Remote PWA (step 4.4, design §11 Phase A).
//
// Its only job is **installability + an offline shell**. The live data (statuses,
// usage, actions) all flows over the WebSocket / `/api` and is never cached — when the
// desktop Workbench is off, the cached shell still loads and the page shows "offline"
// (the §11 "just shows offline" case) instead of a browser error screen.
//
// Strategy:
//   • Precache the static shell (the page, manifest, icons) on install.
//   • `/api/*` and `/pair` → network only, never cached (auth + live state must be fresh).
//   • Everything else (navigations + static assets) → network-first, falling back to the
//     cache so the app opens with no connection.
// Bump CACHE when any shell asset changes so old caches are dropped on activate.

const CACHE = "wb-remote-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // POST /pair, POST /api/action: pass straight through

  const url = new URL(req.url);
  // Never cache the live data plane — let it hit the network (and fail cleanly when off).
  if (url.pathname.startsWith("/api") || url.pathname === "/pair") return;

  // Network-first so an updated shell propagates; fall back to cache (then the cached
  // index for a bare navigation) when the desktop is unreachable.
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("/"))),
  );
});
