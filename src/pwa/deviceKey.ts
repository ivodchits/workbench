// The device key (assistant plan R3): a P-256 key pair the browser makes at
// pairing. The private half is not extractable, so it can't be read out of the
// phone, only used; it lives in IndexedDB (a CryptoKey is stored as it is). The
// public half goes to the desktop with the pairing code. From then on the page
// signs a challenge once per visit for a session (`net.ts`), and the device token
// alone opens nothing.
//
// WebCrypto exists only on a secure page: over the https (Funnel) address the
// phone gets a key, over the tailnet's plain http it pairs without one, as before.

/** What the desktop expects signed before the challenge (`auth::PROOF_PREFIX`). */
export const PROOF_PREFIX = "workbench-remote-session:";

const DB_NAME = "wb-remote";
const STORE = "keys";
const KEY_ID = "device";

const ALGORITHM: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };

/** Whether this page can have a device key. */
export function keysAvailable(): boolean {
  return typeof indexedDB !== "undefined" && typeof crypto !== "undefined" && !!crypto.subtle && isSecureContext;
}

/** Bytes as base64url without padding, as the desktop reads them. */
export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A new key pair, its private half not extractable. */
export function newKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ALGORITHM, false, ["sign", "verify"]);
}

/** The public half as the desktop takes it: the uncompressed point, base64url. */
export async function publicKeyOf(pair: CryptoKeyPair): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
}

/** The proof for `challenge`: WebCrypto's 64-byte `r‖s`, base64url. */
export async function signChallenge(key: CryptoKey, challenge: string): Promise<string> {
  const data = new TextEncoder().encode(PROOF_PREFIX + challenge);
  return base64url(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data)));
}

// ── where the key is kept ───────────────────────────────────────────────────

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB didn't open"));
  });
}

async function inStore<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB failed"));
    });
  } finally {
    db.close();
  }
}

let held: Promise<CryptoKey | null> | null = null;

/** Make and keep a new key, in place of any before; resolves to its public half,
 *  or null where the page can't have one. */
export async function makeDeviceKey(): Promise<string | null> {
  if (!keysAvailable()) return null;
  try {
    const pair = await newKeyPair();
    await inStore("readwrite", (s) => s.put(pair, KEY_ID));
    held = Promise.resolve(pair.privateKey);
    return await publicKeyOf(pair);
  } catch {
    return null;
  }
}

/** The kept key's private half, or null when there is none. */
export function deviceKey(): Promise<CryptoKey | null> {
  if (!keysAvailable()) return Promise.resolve(null);
  held ??= inStore<CryptoKeyPair | undefined>("readonly", (s) => s.get(KEY_ID))
    .then((pair) => pair?.privateKey ?? null)
    .catch(() => null);
  return held;
}

/** Forget the key (unpairing, or a desktop that didn't take it). */
export async function dropDeviceKey(): Promise<void> {
  held = Promise.resolve(null);
  if (!keysAvailable()) return;
  await inStore("readwrite", (s) => s.delete(KEY_ID)).catch(() => {});
}
