// Service worker for the Workbench Remote PWA (step 4.4, design §11 Phase A).
//
// Its jobs are **installability + an offline shell**, and showing the desktop's
// pushes (step R6) while the page is closed. The live data (statuses,
// usage, actions) all flows over the WebSocket / `/api` and is never cached — when the
// desktop Workbench is off, the cached shell still loads and the page shows "offline"
// (the §11 "just shows offline" case) instead of a browser error screen.
//
// Strategy:
//   • Precache the static shell (the page, manifest, icons) on install.
//   • `/api/*` and `/pair` → network only, never cached (auth + live state must be fresh).
//   • Everything else (navigations + static assets) → network-first, falling back to the
//     cache so the app opens with no connection.
//
// The build (`vite.pwa.config.js`) writes the cache name: it carries a hash of the
// shell, so any change to the page or its assets drops the old cache on activate.

const CACHE = "__WB_CACHE__";
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

// --- push (step R6) ---------------------------------------------------------------
// The desktop pushes on needs-you and escalation: { title, body, instanceId, tag }.
// A tag per instance makes a newer push about the same card replace the older one.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Workbench", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Workbench", {
      body: data.body || "",
      tag: data.tag || "workbench",
      renotify: true,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { instanceId: data.instanceId || null },
    }),
  );
});

// Tapping a notification opens (or focuses) the dashboard on that instance.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const id = event.notification.data && event.notification.data.instanceId;
  const target = id ? `/#instance=${encodeURIComponent(id)}` : "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (new URL(w.url).origin !== self.location.origin) continue;
        w.postMessage({ type: "open-instance", instanceId: id });
        return w.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
