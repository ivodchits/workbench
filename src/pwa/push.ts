// Notifications on the phone (step R6): subscribe this device to the desktop's
// pushes, mute and unmute them, and keep the desktop's copy of the subscription
// current.
//
// Browser rules shape this: push needs a secure page (the Funnel address, R3 —
// not the plain tailnet one), permission can only be asked from a tap, and on
// iPhone only an app added to the home screen may subscribe.
//
// Duck's Android app is a WebView, which has no Push API: there the subscription
// comes from the phone's UnifiedPush distributor (ntfy, say) through the app
// (`native.ts`, `Push.kt`). It is the same kind of Web Push endpoint, so the
// desktop gets it the same way and pushes to it the same way.
//
// Muting is easy to do by accident and silent afterwards (the desktop just skips
// the device), so the button says which state it's in, muting asks first, and
// "send a test" checks the whole path and shows what the push service said.

import { $ } from "./dom";
import * as app from "./native";
import { api } from "./net";

interface Status {
  publicKey: string;
  subscribed: boolean;
  endpoint: string | null;
  muted: boolean;
  /** Why the last push to this device failed, until one gets through. */
  lastError: string | null;
}

const KEY_STORE = "wb-push-key";

function supported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** The VAPID key as the browser wants it. */
function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function show(text: string, title: string, enabled = true): void {
  const b = $<HTMLButtonElement>("pushBtn");
  b.textContent = text;
  b.title = title;
  b.disabled = !enabled;
  b.classList.remove("hidden");
}

function showTest(visible: boolean, text = "send a test notification", title = ""): void {
  const b = $<HTMLButtonElement>("pushTestBtn");
  b.textContent = text;
  b.title = title;
  b.classList.toggle("hidden", !visible);
}

async function subscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** Subscribe with the desktop's key (replacing a subscription made with another
 *  key, say after the desktop's database was reset) and tell the desktop. */
async function subscribe(status: Status): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  let storedKey: string | null = null;
  try {
    storedKey = localStorage.getItem(KEY_STORE);
  } catch {
    // no storage: resubscribing is harmless
  }
  if (sub && storedKey !== status.publicKey) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(status.publicKey) });
  try {
    localStorage.setItem(KEY_STORE, status.publicKey);
  } catch {
    // as above
  }
  await api("/api/push/subscribe", { body: sub.toJSON() });
}

// ── in Duck's app ──

const REGISTER_WAIT_MS = 30_000;

/** The app's endpoint, when it was made for the desktop's current key. */
async function appEndpoint(status: Status): Promise<app.AppPush["endpoint"]> {
  const p = await app.pushStatus();
  return p.vapid === status.publicKey ? p.endpoint : null;
}

function sendAppEndpoint(e: NonNullable<app.AppPush["endpoint"]>): Promise<unknown> {
  return api("/api/push/subscribe", { body: { endpoint: e.endpoint, keys: { p256dh: e.p256dh, auth: e.auth } } });
}

/** Register with the distributor and wait for its endpoint. */
async function appSubscribe(status: Status): Promise<void> {
  await app.pushRegister(status.publicKey);
  const end = Date.now() + REGISTER_WAIT_MS;
  for (;;) {
    const p = await app.pushStatus();
    if (p.endpoint && p.vapid === status.publicKey) return void (await sendAppEndpoint(p.endpoint));
    if (p.error) throw new Error(p.error);
    if (Date.now() > end) throw new Error("the distributor didn't answer");
    await new Promise((ok) => setTimeout(ok, 500));
  }
}

/** The local subscription's endpoint (the browser's, or the app's), if any. */
async function localEndpoint(status: Status): Promise<string | null> {
  if (supported()) return Notification.permission === "granted" ? ((await subscription())?.endpoint ?? null) : null;
  return (await appEndpoint(status))?.endpoint ?? null;
}

/** The app's half of `refresh`: false when there's nothing more to show. */
async function refreshApp(status: Status): Promise<boolean> {
  const p = await app.pushStatus();
  if (!p.distributors.length) {
    show(
      "notifications: install ntfy first · tap when done",
      "the app gets pushes through a UnifiedPush distributor: install ntfy (or another) from the store, then come back",
    );
    return false;
  }
  const e = p.vapid === status.publicKey ? p.endpoint : null;
  if (e && (!status.subscribed || status.endpoint !== e.endpoint)) {
    try {
      await sendAppEndpoint(e);
      status.subscribed = true;
      status.endpoint = e.endpoint;
    } catch {
      // try again next time
    }
  }
  if (p.error && !e) {
    show("notifications: failed · tap to retry", p.error);
    return false;
  }
  return true;
}

async function refresh(): Promise<void> {
  showTest(false);
  if (!supported() && app.inApp()) {
    let status: Status;
    try {
      status = await api<Status>("/api/push");
      if (!(await refreshApp(status))) return;
    } catch {
      return; // offline: leave the button as it was
    }
    return showState(status, await localEndpoint(status));
  }
  if (!supported()) {
    show(
      "notifications: not here",
      isSecureContext
        ? "this browser has no push — on iPhone, add the app to the home screen first"
        : "notifications need the https (Funnel) address of Workbench",
      false,
    );
    return;
  }
  if (Notification.permission === "denied") {
    show("notifications: blocked", "allow notifications for this site in the browser settings", false);
    return;
  }
  let status: Status;
  try {
    status = await api<Status>("/api/push");
  } catch {
    return; // offline: leave the button as it was
  }
  const sub = Notification.permission === "granted" ? await subscription() : null;
  // Granted and subscribed here, but the desktop lost it (unpaired and paired
  // again, a reset): send it again quietly.
  if (sub && (!status.subscribed || status.endpoint !== sub.endpoint)) {
    try {
      await subscribe(status);
      status = { ...status, subscribed: true, endpoint: sub.endpoint };
    } catch {
      // try again next time
    }
  }
  showState(status, sub?.endpoint ?? null);
}

/** The button for the desktop's view (`status`) and this phone's (`local`). */
function showState(status: Status, local: string | null): void {
  if (!status.subscribed || !local) {
    show("turn on notifications", "be told when an agent needs you, with the app closed");
    return;
  }
  if (status.muted) show("🔕 notifications muted · tap to unmute", "the desktop sends this device nothing until you unmute");
  else show("🔔 notifications on · tap to mute", "this device is told when an agent needs you");
  if (status.lastError) showTest(true, "⚠ last push failed · send a test", status.lastError);
  else showTest(true);
}

async function onTest(): Promise<void> {
  const b = $<HTMLButtonElement>("pushTestBtn");
  b.disabled = true;
  try {
    await api("/api/push/test", { body: {} });
    showTest(true, `test sent · no notification? check the phone's settings for ${app.inApp() ? "Duck and the distributor" : "this browser"}`);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    showTest(true, `test failed: ${why} · tap to retry`, why);
  } finally {
    b.disabled = false;
  }
}

async function onTap(): Promise<void> {
  const btn = $<HTMLButtonElement>("pushBtn");
  btn.disabled = true;
  let failed = false;
  try {
    const status = await api<Status>("/api/push");
    const inBrowser = supported();
    if (!inBrowser && !app.inApp()) return;
    if (!status.subscribed || !(await localEndpoint(status))) {
      if (inBrowser) {
        if ((await Notification.requestPermission()) !== "granted") return;
        await subscribe(status);
      } else {
        if (!(await app.pushStatus()).distributors.length) return; // refresh says what to install
        await appSubscribe(status);
      }
      // Turning notifications on means on: clear a mute left from before.
      if (status.muted) await api("/api/push/mute", { body: { muted: false } });
    } else if (status.muted || confirm("Mute notifications on this device? The desktop will send it nothing until you unmute.")) {
      await api("/api/push/mute", { body: { muted: !status.muted } });
    }
  } catch (e) {
    failed = true;
    show("notifications: failed — tap to retry", app.reason(e));
  } finally {
    btn.disabled = false;
    // A failure stays on the button until the next tap.
    if (!failed) await refresh();
  }
}

/** Wire the notifications button; `open` shows an instance a tapped push names. */
export function initPush(open: (instanceId: string) => void): void {
  $("pushBtn").onclick = () => void onTap();
  $("pushTestBtn").onclick = () => void onTest();
  void refresh();
  if (app.inApp()) void app.onPushEndpoint(() => void refresh()).catch(() => {});
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (e: MessageEvent<{ type?: string; instanceId?: string }>) => {
      if (e.data?.type === "open-instance" && e.data.instanceId) open(e.data.instanceId);
    });
  }
}

/** The instance a tapped push opened the page on (`#instance=…`), once. */
export function takeLaunchInstance(): string | null {
  const m = /^#instance=(.+)$/.exec(location.hash);
  if (!m) return null;
  history.replaceState(null, "", location.pathname + location.search);
  return decodeURIComponent(m[1]);
}
