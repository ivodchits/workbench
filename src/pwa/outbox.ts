// What was written on the phone while the desktop couldn't take it: prompts to
// sessions, messages to Duck, note edits and quick notes. Each waits here, kept
// on the device (`store.ts`), shown as pending where it was written, and goes to
// the desktop when the link is back — in the order written, per kind.
//
// The desktop is the authority. A note edit names the revision it started from,
// so one that meets a newer note is not forced through: it stays here as
// `failed`, with the text kept, for the note's own conflict view to settle. A
// Duck message has no answer of its own; it counts as delivered when Duck's
// socket hands it back, and one the socket dropped first is offered again rather
// than sent twice. Nothing typed is thrown away unless the user says so.
//
// Pure apart from the `persist` it is given, so it is tested on its own.

export type OutboxBody =
  | { kind: "prompt"; instanceId: string; text: string }
  | { kind: "duck"; threadId: string | null; text: string }
  | { kind: "noteSave"; projectId: string; noteId: string; content: string; base: string | null }
  | { kind: "noteCreate"; projectId: string; name: string; content: string };

export type OutboxKind = OutboxBody["kind"];

/** - `pending` — waits for the link;
 *  - `sending` — on its way;
 *  - `sent` — handed over, waiting for the desktop to show it arrived (Duck);
 *  - `failed` — the desktop refused it, or it may not have arrived: the user
 *    retries or discards it. */
export type OutboxState = "pending" | "sending" | "sent" | "failed";

export type OutboxItem = OutboxBody & {
  id: string;
  /** When it was written (epoch ms). */
  at: number;
  state: OutboxState;
  error?: string;
};

/** What a sender made of one item:
 *  - `done` — delivered: it goes;
 *  - `sent` — handed over; `confirm` removes it later;
 *  - `wait` — the desktop isn't there: it stays pending, and this kind waits;
 *  - `{ failed }` — refused, with why: it stays for the user. */
export type SendResult = "done" | "sent" | "wait" | { failed: string };

export type Sender = (item: OutboxItem) => Promise<SendResult>;

export interface Outbox {
  list(): readonly OutboxItem[];
  /** Items of a kind matching `pick`. */
  find<K extends OutboxKind>(kind: K, pick?: (it: Extract<OutboxItem, { kind: K }>) => boolean): Extract<OutboxItem, { kind: K }>[];
  add(body: OutboxBody): OutboxItem;
  /** Change an item (a note edit typed again replaces the waiting text). */
  update(id: string, patch: Partial<OutboxBody>): void;
  remove(id: string): void;
  /** A `sent` item arrived: it goes. */
  confirm(id: string): void;
  /** `sent` items of a kind that will now never be confirmed (the socket
   *  dropped): offered back to the user. */
  unconfirmed(kind: OutboxKind, why: string): void;
  /** Put a failed item back in line. */
  retry(id: string): void;
  handle(kind: OutboxKind, send: Sender): void;
  /** Try every pending item; resolves when the pass is over. */
  flush(): Promise<void>;
  /** Hear every change. */
  subscribe(cb: () => void): () => void;
  /** The items kept from before (the page's start): `pending` again if they
   *  were mid-way. */
  restore(items: unknown): void;
}

let counter = 0;
const newId = () => `${Date.now().toString(36)}-${(++counter).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function createOutbox(persist: (items: OutboxItem[]) => void): Outbox {
  let items: OutboxItem[] = [];
  const senders = new Map<OutboxKind, Sender>();
  const listeners = new Set<() => void>();
  let running: Promise<void> | null = null;
  let again = false;

  const changed = () => {
    persist(items);
    for (const cb of [...listeners]) cb();
  };
  const set = (id: string, patch: Partial<OutboxItem>) => {
    items = items.map((it) => (it.id === id ? ({ ...it, ...patch } as OutboxItem) : it));
  };

  async function pass(): Promise<void> {
    const waiting = new Set<OutboxKind>();
    for (const it of [...items]) {
      if (it.state !== "pending" || waiting.has(it.kind)) continue;
      const send = senders.get(it.kind);
      if (!send) continue;
      // Still here, and still pending (removed or retried meanwhile)?
      const now = items.find((x) => x.id === it.id);
      if (!now || now.state !== "pending") continue;
      set(it.id, { state: "sending", error: undefined });
      changed();
      let r: SendResult;
      try {
        r = await send(items.find((x) => x.id === it.id) ?? now);
      } catch {
        r = "wait";
      }
      if (!items.some((x) => x.id === it.id)) continue; // discarded while sending
      if (r === "done") items = items.filter((x) => x.id !== it.id);
      else if (r === "sent") set(it.id, { state: "sent" });
      else if (r === "wait") {
        set(it.id, { state: "pending" });
        waiting.add(it.kind); // keep this kind in order
      } else set(it.id, { state: "failed", error: r.failed });
      changed();
    }
  }

  const box: Outbox = {
    list: () => items,
    find: (kind, pick) =>
      items.filter((it) => it.kind === kind && (!pick || pick(it as never))) as never,
    add(body) {
      const it = { ...body, id: newId(), at: Date.now(), state: "pending" } as OutboxItem;
      items = [...items, it];
      changed();
      return it;
    },
    update(id, patch) {
      set(id, patch as Partial<OutboxItem>);
      changed();
    },
    remove(id) {
      const before = items.length;
      items = items.filter((it) => it.id !== id);
      if (items.length !== before) changed();
    },
    confirm(id) {
      box.remove(id);
    },
    unconfirmed(kind, why) {
      let any = false;
      for (const it of items)
        if (it.kind === kind && (it.state === "sent" || it.state === "sending")) {
          set(it.id, { state: "failed", error: why });
          any = true;
        }
      if (any) changed();
    },
    retry(id) {
      set(id, { state: "pending", error: undefined });
      changed();
      void box.flush();
    },
    handle(kind, send) {
      senders.set(kind, send);
    },
    flush() {
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        do {
          again = false;
          await pass();
        } while (again);
      })().finally(() => (running = null));
      return running;
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    restore(raw) {
      if (!Array.isArray(raw)) return;
      const kept = (raw as OutboxItem[])
        .filter((it) => it && typeof it.id === "string" && typeof it.kind === "string")
        // Mid-way when the page went: whether it got there isn't known. A note
        // save is safe to send again (it names its base, and meeting itself is
        // no conflict); anything else might go twice, so it is offered back.
        .map((it): OutboxItem =>
          it.state === "sending" || it.state === "sent"
            ? it.kind === "noteSave"
              ? { ...it, state: "pending" }
              : { ...it, state: "failed", error: "may not have arrived" }
            : it,
        );
      // Anything added before the kept list loaded goes after it.
      items = [...kept.filter((k) => !items.some((it) => it.id === k.id)), ...items];
      changed();
    },
  };
  return box;
}

/** A short line for an item, for lists. */
export function describe(it: OutboxItem): string {
  switch (it.kind) {
    case "prompt":
    case "duck":
      return it.text;
    case "noteSave":
      return `edit of “${it.noteId}”`;
    case "noteCreate":
      return `new note “${it.name}”`;
  }
}
