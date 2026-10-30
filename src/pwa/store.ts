// What the phone keeps of the desktop's data between opens: the last snapshot,
// Duck's threads, notes, the tail of each session's transcript, and the outbox
// of what was written while offline (`outbox.ts`). The desktop is always the
// authority; this is only what to show until it answers.
//
// One IndexedDB store of JSON values by key, so a page opened with the desktop
// unreachable still has something to show. Where there is no IndexedDB (a
// private tab, the tests) it falls back to memory: the page works, it just
// remembers nothing across opens.
//
// It lives on the page's own origin, so in Duck's app it is the app webview's
// storage for the desktop's address: other apps can't read it, but anyone with
// the unlocked phone and the app can. `forget this device` clears it.

const DB_NAME = "wb-remote-cache";
const STORE = "kv";

/** Where values go: IndexedDB in a browser, a Map in tests. */
export interface Backend {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
}

export function memoryBackend(): Backend {
  const map = new Map<string, unknown>();
  return {
    get: async (key) => (map.has(key) ? structuredClone(map.get(key)) : undefined),
    set: async (key, value) => void map.set(key, structuredClone(value)),
    del: async (key) => void map.delete(key),
    keys: async () => [...map.keys()],
    clear: async () => map.clear(),
  };
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("indexedDB request failed"));
  });
}

function idbBackend(): Backend | null {
  if (typeof indexedDB === "undefined") return null;
  let db: Promise<IDBDatabase> | null = null;
  const open = () =>
    (db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error ?? new Error("indexedDB open failed"));
      r.onblocked = () => reject(new Error("indexedDB blocked"));
    }));
  const tx = async (mode: IDBTransactionMode) => (await open()).transaction(STORE, mode).objectStore(STORE);
  return {
    get: async (key) => req((await tx("readonly")).get(key)),
    set: async (key, value) => void (await req((await tx("readwrite")).put(value, key))),
    del: async (key) => void (await req((await tx("readwrite")).delete(key))),
    keys: async () => (await req((await tx("readonly")).getAllKeys())).map(String),
    clear: async () => void (await req((await tx("readwrite")).clear())),
  };
}

let backend: Backend | null = null;

/** Use `b` from now on (tests). */
export function useBackend(b: Backend): void {
  backend = b;
}

function current(): Backend {
  return (backend ??= idbBackend() ?? memoryBackend());
}

/** Run `op`; when IndexedDB itself fails (quota, a broken profile), carry on in
 *  memory rather than break the page. */
async function guarded<T>(op: (b: Backend) => Promise<T>, fallback: T): Promise<T> {
  try {
    return await op(current());
  } catch {
    backend = memoryBackend();
    try {
      return await op(backend);
    } catch {
      return fallback;
    }
  }
}

export function load<T>(key: string): Promise<T | undefined> {
  return guarded((b) => b.get(key) as Promise<T | undefined>, undefined);
}

export function save(key: string, value: unknown): Promise<void> {
  return guarded((b) => b.set(key, value), undefined);
}

export function drop(key: string): Promise<void> {
  return guarded((b) => b.del(key), undefined);
}

export function keys(prefix = ""): Promise<string[]> {
  return guarded(async (b) => (await b.keys()).filter((k) => k.startsWith(prefix)), []);
}

/** Everything kept: on unpairing. */
export function clearAll(): Promise<void> {
  return guarded((b) => b.clear(), undefined);
}

/** `save`, at most once per `ms` per key: the latest value wins. For state that
 *  changes every couple of seconds (snapshots), so the disk isn't written each time. */
export function saver(key: string, ms = 1500): { (value: unknown): void; flush(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest: unknown;
  let have = false;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!have) return;
    have = false;
    void save(key, latest);
  };
  const fn = (value: unknown) => {
    latest = value;
    have = true;
    timer ??= setTimeout(flush, ms);
  };
  fn.flush = flush;
  // A page going to the background may be killed without another chance.
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => document.hidden && flush());
  return fn;
}
