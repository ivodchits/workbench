// Service worker for the Workbench Remote PWA (step 4.4, design §11 Phase A).
//
// Its jobs are **installability + an offline shell**, and showing the desktop's
// pushes (step R6) while the page is closed. The live data (statuses,
// usage, actions) all flows over the WebSocket / `/api` and is never cached here —
// the page keeps its own copy of what it was last shown (`store.ts`). When the
// desktop Workbench is off, the cached shell still loads and the page shows what
// it kept, marked offline, instead of a browser error screen.
//
// Strategy:
//   • Precache the static shell (the page, manifest, icons) on install.
//   • `/api/*` and `/pair` → network only, never cached (auth + live state must be fresh).
//   • Everything else (navigations + static assets) → stale-while-revalidate: the
//     cached copy at once, so the page opens without waiting on the desktop (over
//     Funnel, the page alone is a long download), and refreshed from the network
//     behind it for the next open. With nothing cached, the network.
//
// The build (`vite.pwa.config.js`) writes the cache name: it carries a hash of the
// shell, so any change to the page or its assets makes a new worker, which
// precaches the new shell and drops the old cache on activate; the page hears the
// new worker take over and offers a reload (`main.ts`).
//
// Sharing to Duck (assistant plan R3): Android posts a share to `/share` (the
// manifest's `share_target`). A navigation can't carry the device token, so the
// worker takes the share itself, keeps it for the page in its own cache, and sends
// the page to `/?duck=share`, which hands it to Duck.

const CACHE = "__WB_CACHE__";
/** Where a share waits for the page; not the shell's, so a new shell keeps it. */
const SHARE_CACHE = "wb-share";
const SHELL = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== SHARE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method === "POST" && url.pathname === "/share") {
    event.respondWith(takeShare(req));
    return;
  }
  if (req.method !== "GET") return; // POST /pair, POST /api/action: pass straight through

  // Never cache the live data plane — let it hit the network (and fail cleanly when off).
  if (url.pathname.startsWith("/api") || url.pathname === "/pair") return;

  // A navigation is the one page, whatever its query (`/?duck=chat`) or hash.
  const key = req.mode === "navigate" ? "/" : req;
  // The copy for the cache is taken before the page can read the answer.
  let copy = null;
  const refresh = fetch(req).then((res) => {
    if (res.ok) copy = res.clone();
    return res;
  });
  // Kept for the next open; the worker stays up until it is written.
  event.waitUntil(
    refresh
      .then(() => copy && caches.open(CACHE).then((c) => c.put(key, copy)))
      .catch(() => {}),
  );
  event.respondWith(
    caches.match(key).then((hit) => {
      if (hit) {
        refresh.catch(() => {}); // offline: the cached copy is all there is
        return hit;
      }
      return refresh.catch(() => caches.match("/").then((home) => home || Response.error()));
    }),
  );
});

/** Keep a share (title, text, link, and since G1 images and PDFs) for the page
 *  and open Duck on it. Only one waits: a newer share replaces it. Each file is
 *  kept as its own entry, at most 10 of up to 25 MB. */
async function takeShare(req) {
  const field = (form, name) => {
    const v = form.get(name);
    return typeof v === "string" ? v.slice(0, 20000) : "";
  };
  let share = null;
  let files = [];
  try {
    const form = await req.formData();
    share = { title: field(form, "title"), text: field(form, "text"), url: field(form, "url"), at: Date.now(), files: [] };
    files = form
      .getAll("files")
      .filter((f) => typeof f !== "string" && f.size <= 25 * 1024 * 1024)
      .slice(0, 10);
  } catch {
    // An unreadable post: the page says the share was lost.
  }
  if (share) {
    const cache = await caches.open(SHARE_CACHE);
    for (const key of await cache.keys()) await cache.delete(key);
    for (const [i, f] of files.entries()) {
      const key = `/__share-file-${i}`;
      await cache.put(key, new Response(f, { headers: { "Content-Type": f.type || "application/octet-stream" } }));
      share.files.push({ name: f.name || `shared-${i + 1}`, key });
    }
    await cache.put("/__share", new Response(JSON.stringify(share), { headers: { "Content-Type": "application/json" } }));
  }
  return Response.redirect(new URL(share ? "/?duck=share" : "/?duck=share-lost", self.location.origin).href, 303);
}

// --- push (step R6) ---------------------------------------------------------------
// The desktop pushes on needs-you and escalation: { title, body, instanceId, tag }.
// A tag per instance makes a newer push about the same card replace the older one.
// Duck pushes when it waits for a yes or no (step R1): { title, body, threadId, tag }.
// A reminder (step H4) adds `reminder: { id, token }`: Done and Snooze buttons,
// which post the token back (the worker can't sign in; the token is the key).
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
      ...(data.reminder && {
        actions: [
          { action: "done", title: "Done" },
          { action: "snooze", title: "Snooze 10 min" },
        ],
        requireInteraction: true,
      }),
      data: { instanceId: data.instanceId || null, threadId: data.threadId || null, reminder: data.reminder || null },
    }),
  );
});

// Tapping a notification opens (or focuses) the dashboard on that instance, or Duck
// on that thread.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  if (data.reminder && (event.action === "done" || event.action === "snooze")) {
    event.waitUntil(reminderAction(data.reminder, event.action));
    return;
  }
  const id = data.instanceId;
  const thread = data.threadId;
  const target = thread
    ? `/#duck=${encodeURIComponent(thread)}`
    : id
      ? `/#instance=${encodeURIComponent(id)}`
      : "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (new URL(w.url).origin !== self.location.origin) continue;
        w.postMessage(thread ? { type: "open-duck", threadId: thread } : { type: "open-instance", instanceId: id });
        return w.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});

/** A reminder's Done or Snooze, to the desktop. When it doesn't get there, a
 *  notification says so, so the tap isn't lost silently. */
async function reminderAction(reminder, action) {
  let error = "";
  try {
    const res = await fetch("/api/reminders/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: reminder.token, action }),
    });
    if (!res.ok) error = ((await res.json().catch(() => ({}))).error) || `the desktop said ${res.status}`;
  } catch {
    error = "the desktop isn't reachable";
  }
  if (error)
    await self.registration.showNotification(action === "done" ? "Not marked done" : "Not snoozed", {
      body: `${error}. Tell Duck instead.`,
      tag: `reminder-${reminder.id}`,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
    });
}
