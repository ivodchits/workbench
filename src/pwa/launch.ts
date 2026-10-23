// How the page was opened (assistant plan R3): an app shortcut (`/?duck=talk`,
// `chat`, `task`, `status`), a share from another app (`/?duck=share`, the service
// worker keeping what was shared), or plainly. Pure, apart from `takeLaunch` and
// `takeShare`, which read the page's address and the worker's cache once.

/** What a shortcut or a share asks of Duck. */
export type Launch = "talk" | "chat" | "task" | "status" | "share" | "share-lost";

const LAUNCHES: readonly Launch[] = ["talk", "chat", "task", "status", "share", "share-lost"];

/** What another app shared, as the service worker kept it. */
export interface Share {
  title: string;
  text: string;
  url: string;
  /** When it was shared (epoch ms). */
  at: number;
  /** Images and PDFs shared (step G1), staged like a 📎 pick. */
  files?: { blob: Blob; name: string }[];
}

/** How the service worker keeps a shared file: its name and its cache key. */
interface KeptFile {
  name: string;
  key: string;
}

/** A share older than this when the page reads it is dropped (left over). */
export const SHARE_MAX_AGE_MS = 10 * 60_000;

/** "What needs me?": sent as it is, from the shortcut. */
export const STATUS_ASK = "What needs me right now?";

/** A new task's composer starts with this. */
export const TASK_LEAD = "New task: ";

/** What a share can be sent with, as one tap. */
export const SHARE_ASKS: readonly { label: string; ask: string }[] = [
  { label: "summarize", ask: "Summarize this for me." },
  { label: "make a task of it", ask: "Make a task of this." },
  { label: "remember it", ask: "Remember this." },
];

/** The launch named in a page address's query, if any. */
export function launchOf(search: string): Launch | null {
  const v = new URLSearchParams(search).get("duck");
  return LAUNCHES.includes(v as Launch) ? (v as Launch) : null;
}

/** What was shared, a line each: the title, the link and the text. Android's
 *  browsers often put the link in `text` too; it's said once. */
export function shareLines(s: Pick<Share, "title" | "text" | "url">): string[] {
  const url = s.url.trim() || /https?:\/\/\S+/.exec(s.text.trim())?.[0] || "";
  const text = url ? s.text.replace(url, "").replace(/[ \t]{2,}/g, " ").trim() : s.text.trim();
  return [s.title.trim(), url, text].filter(Boolean);
}

/** The share as the message's body, in a `<shared>` wrapper (it came from another
 *  app: data, not instructions); empty when nothing came. */
export function shareBody(s: Pick<Share, "title" | "text" | "url">): string {
  const lines = shareLines(s);
  return lines.length ? `Shared from my phone:\n<shared>\n${lines.join("\n")}\n</shared>` : "";
}

/** The message for a share sent with `ask` (one of `SHARE_ASKS`, or typed). */
export function shareMessage(ask: string, body: string): string {
  return [ask.trim(), body].filter(Boolean).join("\n\n");
}

/** The launch this page was opened with, once: the query is taken off the address. */
export function takeLaunch(): Launch | null {
  const launch = launchOf(location.search);
  if (launch) history.replaceState(null, "", location.pathname + location.hash);
  return launch;
}

/** The share the service worker kept, once; null when there's none, or it's old. */
export async function takeShare(now = Date.now()): Promise<Share | null> {
  if (typeof caches === "undefined") return null;
  try {
    const cache = await caches.open("wb-share");
    const hit = await cache.match("/__share");
    await cache.delete("/__share");
    if (!hit) return null;
    const s = (await hit.json()) as Omit<Share, "files"> & { files?: KeptFile[] };
    const files: { blob: Blob; name: string }[] = [];
    for (const f of s.files ?? []) {
      const r = await cache.match(f.key);
      await cache.delete(f.key);
      if (r) files.push({ blob: await r.blob(), name: f.name });
    }
    if (now - s.at > SHARE_MAX_AGE_MS) return null;
    return { title: s.title, text: s.text, url: s.url, at: s.at, ...(files.length && { files }) };
  } catch {
    return null;
  }
}
