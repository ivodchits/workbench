// Drawings (step G3): Duck asks, a worker draws, the canvas shows it.
//
// A drawing is a source with versions (`drawings/<id>/v<n>.<ext>` in its worker's
// task folder); the rendered SVG and PNG are a cache, stored as attachments so the
// card, the canvas and the phone can show them.
//
// - `draw` starts the thread's drawing worker (a D1 task of kind `drawing`), or
//   when one is warm (its last run is done and its session is still up), sends it
//   the request as a follow-up. An edit is the drawing's next version, with the
//   latest one's path to start from.
// - When the worker's run ends, `report` (the task manager's hook) reads the
//   version, renders it (`src/drawing/`), stores the SVG and PNG, posts the card in
//   the thread and the `drawing` event (which opens the canvas on the surface the
//   request came from), and gives Duck a short report instead of the usual one.
//   A version that doesn't render goes back to the worker once with the error.
// - An API worker (over the limits, with `allowApi`) can't write files: it hands
//   the source in `result.md` as a fenced block, which is written as the version.
// - While a thread's canvas is open on a surface (`viewing`), its drawing worker
//   isn't stopped for being idle (`keepWarm`).

import { z } from "zod";

import { DRAWING_KINDS, EXT, fencedSource, kindOf, type DrawingKind } from "../drawing/kinds";
import { attachBytes, drawingList, drawingPut, drawingSource, drawingWrite, taskResult } from "../ipc/assistant";
import type { AttachmentRef } from "./attachments";
import type { DrawingView, Notice, Surface } from "./protocol";
import type { Tier } from "./settings";
import type { Task, TaskManager } from "./tasks";

const Ref = z.object({ id: z.string(), name: z.string(), mime: z.string(), size: z.number(), path: z.string().optional() });

export const Version = z.object({
  n: z.number(),
  ext: z.enum(["mmd", "svg", "json"]),
  /** The source file. */
  path: z.string(),
  workspace: z.string(),
  folder: z.string(),
  taskId: z.string(),
  headline: z.string(),
  at: z.number(),
  png: Ref.nullable(),
  svg: Ref.nullable(),
});
export type Version = z.infer<typeof Version>;

export const Drawing = z.object({
  id: z.string(),
  threadId: z.string(),
  title: z.string(),
  /** Null until the worker picks one (its first version). */
  kind: z.enum(DRAWING_KINDS).nullable(),
  versions: z.array(Version),
  /** The version being drawn, by which task; `fixed` once it went back with a
   *  render error. */
  pending: z.object({ taskId: z.string(), n: z.number(), at: z.number(), fixed: z.boolean() }).nullable(),
  /** Where the latest request came from: the canvas opens there. */
  surface: z.enum(["desktop", "phone"]).nullable(),
  created: z.number(),
});
export type Drawing = z.infer<typeof Drawing>;

export interface DrawingSourceFile {
  ext: "mmd" | "svg" | "json";
  text: string;
  path: string;
}

export interface DrawingBackend {
  put(d: Drawing): Promise<void>;
  list(): Promise<Drawing[]>;
  source(workspace: string, folder: string, id: string, n: number): Promise<DrawingSourceFile | null>;
  write(workspace: string, folder: string, id: string, n: number, ext: string, text: string): Promise<string>;
  /** The task's `result.md`. */
  resultMd(workspace: string, folder: string): Promise<string | null>;
  /** Store a rendered file as an attachment. */
  store(name: string, data: Blob): Promise<AttachmentRef>;
}

export interface DrawingRenderer {
  svg(kind: DrawingKind, source: string): Promise<string>;
  png(svg: string): Promise<Blob | null>;
}

export interface DrawRequest {
  threadId: string;
  title: string;
  brief: string;
  kind?: DrawingKind;
  tier: Tier;
  /** An edit: the drawing's id. */
  drawing?: string;
  files?: AttachmentRef[];
  allowApi?: boolean;
  surface?: Surface;
  mandate?: string;
}

export interface Drawings {
  load(): Promise<void>;
  draw(req: DrawRequest): Promise<{ drawing: Drawing; task: Task; how: "started" | "followup" }>;
  /** The task manager's `report` hook. */
  report(t: Task): Promise<string | false | null>;
  /** The task manager's `keepWarm` hook. */
  keepWarm(t: Task): boolean;
  /** The drawing a surface's canvas shows now (null: closed). */
  viewing(surface: Surface, drawingId: string | null): void;
  get(id: string): Drawing | undefined;
  /** Newest first; one thread's when given. */
  list(threadId?: string): Drawing[];
  view(d: Drawing): DrawingView;
  /** A version's SVG, rendered again from its source when it isn't cached. */
  svg(id: string, n: number): Promise<string>;
  /** Hear every change to a drawing; `open` is the surface whose canvas should
   *  show it now (where the request came from). Returns the unsubscribe. */
  subscribe(cb: (d: DrawingView, open?: Surface) => void): () => void;
  dispose(): void;
}

export interface DrawingDeps {
  tasks: TaskManager;
  backend: DrawingBackend;
  render: DrawingRenderer;
  notice: (threadId: string, n: Notice) => void;
  now?: () => number;
  newId?: () => string;
}

/** What each kind must be, for the brief. */
export const KIND_RULES = `Kinds (pick one when the brief doesn't):
- mermaid (\`.mmd\`): flowchart, sequence, state, class, ER, gantt, timeline or mindmap, in Mermaid syntax that Mermaid 12 renders. No HTML in labels; keep labels short. For a hand-drawn look (a sketch), draw a flowchart or a state diagram (Mermaid's hand-drawn look covers only those) and start the file with front matter: \`---\\nconfig:\\n  look: handDrawn\\n---\`.
- svg (\`.svg\`): one standalone SVG for wireframes, schemas and illustrations, with a \`viewBox\`. No <script>, no event attributes (onload…), no <foreignObject>, no external references (fonts, images, stylesheets, links). Use system fonts (Segoe UI, Arial, sans-serif). A sketchy look: slightly wobbly paths, as hand-drawn.
- vega (\`.json\`): a Vega-Lite spec (or Vega) for charts, with its data inline in \`values\`, never a \`url\`.
Readable at 400 px wide: few words per box, text at least 12 px at that width. Colours that work on white and on a dark page: mid-tone fills, dark text on light fills. It's shown on white.`;

/** The drawing part of a brief or follow-up. */
export function drawingSection(id: string, n: number, kind: DrawingKind | null, prev: Version | null): string {
  const where = (ext: string) => `drawings/${id}/v${n}.${ext}`;
  const target = `\`${where(kind ? EXT[kind] : "<ext>")}\` in the task's folder${kind ? "" : " (`mmd`, `svg` or `json` for the kind you pick)"}`;
  return [
    `## The drawing`,
    ``,
    `Drawing \`${id}\`, version ${n}${kind ? `, kind ${kind}` : ""}. Write it to ${target}.${prev ? ` The latest version is \`${prev.path}\`: start from it and change only what's asked.` : ""}`,
    ``,
    KIND_RULES,
    ``,
    `Then write result.json as usual; its headline says in one sentence what the drawing shows. If you can't write files, put the whole source in result.md as one fenced block (\`\`\`mermaid, \`\`\`svg or \`\`\`json).`,
  ].join("\n");
}

/** The prompt that sends a version that didn't render back to its worker. */
export const fixPrompt = (d: Drawing, n: number, path: string, error: string) =>
  `Version ${n} of drawing \`${d.id}\` (\`${path}\`) doesn't render: ${error}. Fix it and write it again to the same file, then update result.json.`;

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "drawing";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A ref as kept in a record: no thumbnail (the card's notice has it). */
const plain = (r: AttachmentRef | null): z.infer<typeof Ref> | null =>
  r && { id: r.id, name: r.name, mime: r.mime, size: r.size, ...(r.path && { path: r.path }) };

const live = (t: Task | undefined) => t?.state === "queued" || t?.state === "running";

export function createDrawings(deps: DrawingDeps): Drawings {
  const { tasks, backend, render } = deps;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => crypto.randomUUID().replace(/-/g, ""));
  const drawings = new Map<string, Drawing>();
  const listeners = new Set<(d: DrawingView, open?: Surface) => void>();
  const tell = (d: Drawing, open?: Surface) => {
    const v = view(d);
    for (const l of listeners) l(v, open);
  };
  const svgs = new Map<string, string>();
  const shown = new Map<Surface, string>();
  /** The pending line each drawing was last shown with, to tell the surfaces when
   *  its worker stops without a version. */
  const lastPending = new Map<string, boolean>();

  function save(d: Drawing, open?: Surface): Drawing {
    drawings.set(d.id, d);
    void backend.put(d).catch((e: unknown) => console.warn("duck: a drawing wasn't stored", e));
    lastPending.set(d.id, pendingNow(d));
    tell(d, open);
    return d;
  }

  const pendingNow = (d: Drawing) => d.pending !== null && live(tasks.get(d.pending.taskId));

  function view(d: Drawing): DrawingView {
    const t = d.pending ? tasks.get(d.pending.taskId) : undefined;
    return {
      id: d.id,
      threadId: d.threadId,
      title: d.title,
      kind: d.kind,
      versions: d.versions.map((v) => ({ n: v.n, ext: v.ext, path: v.path, headline: v.headline, at: v.at, png: v.png, svg: v.svg })),
      pending: d.pending && live(t) ? { n: d.pending.n, waiting: t?.state === "queued" ? (t.why ?? "waiting for a free worker") : null } : null,
    };
  }

  // A worker that stopped without a version (failed, closed, asking): the surfaces
  // stop showing "drawing…".
  const offTasks = tasks.subscribe(() => {
    for (const d of drawings.values()) {
      if (!d.pending) continue;
      const p = pendingNow(d);
      if (lastPending.get(d.id) !== p) {
        lastPending.set(d.id, p);
        tell(d);
      }
    }
  });

  /** The thread's drawing worker, if it's warm: its last run is done and its
   *  session is still there to take a follow-up. */
  function warm(threadId: string): Task | undefined {
    return tasks
      .list()
      .find((t) => t.kind === "drawing" && t.threadId === threadId && t.state === "done" && t.runner === "session" && t.instanceId);
  }

  function find(ref: string): Drawing {
    const d = drawings.get(ref) ?? [...drawings.values()].find((x) => x.title.toLowerCase() === ref.toLowerCase());
    if (!d) throw new Error(`There is no drawing "${ref}". Its id is on its card in the thread.`);
    return d;
  }

  /** A version handed in `result.md` (the API worker), written as its file. */
  async function fromResult(t: Task, d: Drawing, n: number): Promise<DrawingSourceFile | null> {
    const md = await backend.resultMd(t.workspace, t.folder).catch(() => null);
    if (!md) return null;
    for (const kind of d.kind ? [d.kind] : DRAWING_KINDS) {
      const text = fencedSource(md, kind);
      if (!text) continue;
      const path = await backend.write(t.workspace, t.folder, d.id, n, EXT[kind], text);
      return { ext: EXT[kind], text, path };
    }
    return null;
  }

  const api: Drawings = {
    async load() {
      for (const d of await backend.list()) {
        drawings.set(d.id, d);
        lastPending.set(d.id, pendingNow(d));
      }
    },

    async draw(req) {
      const old = req.drawing ? find(req.drawing) : null;
      if (old && old.threadId !== req.threadId) throw new Error(`Drawing ${old.id} belongs to another thread.`);
      if (old?.pending && live(tasks.get(old.pending.taskId)))
        throw new Error(`Drawing ${old.id} is being drawn already (version ${old.pending.n}): wait for it, then ask for the change.`);
      const d: Drawing = old ?? {
        id: newId().slice(0, 8),
        threadId: req.threadId,
        title: req.title.trim(),
        kind: null,
        versions: [],
        pending: null,
        surface: null,
        created: now(),
      };
      const prev = d.versions[d.versions.length - 1] ?? null;
      const n = (prev?.n ?? 0) + 1;
      const kind = req.kind ?? d.kind;
      let task: Task | undefined = req.files?.length ? undefined : warm(req.threadId);
      let how: "started" | "followup" = "followup";
      if (task) {
        try {
          const ask = `A new drawing request from Duck: ${old ? `change drawing \`${d.id}\` ("${d.title}")` : `"${d.title}"`}.\n\n${req.brief.trim()}\n\n${drawingSection(d.id, n, kind, prev)}`;
          await tasks.followup(task.id, ask);
        } catch {
          task = undefined;
        }
      }
      if (!task) {
        how = "started";
        task = await tasks.run({
          threadId: req.threadId,
          title: `Drawing: ${d.title}`.slice(0, 80),
          brief: `${req.brief.trim()}\n\n${drawingSection(d.id, n, kind, prev)}`,
          kind: "drawing",
          tier: req.tier,
          files: req.files,
          allowApi: req.allowApi,
          mandate: req.mandate ? { text: req.mandate, threadId: req.threadId } : undefined,
        });
      }
      const next = save({ ...d, pending: { taskId: task.id, n, at: now(), fixed: false }, surface: req.surface ?? d.surface });
      return { drawing: next, task, how };
    },

    async report(t) {
      const d = [...drawings.values()].find((x) => x.pending?.taskId === t.id);
      if (!d?.pending) return null;
      // A question or a block: the usual report; the drawing waits for the answer.
      if (t.state !== "done") return null;
      const { n } = d.pending;
      const label = `Drawing ${d.id} ("${d.title}")`;
      const src = (await backend.source(t.workspace, t.folder, d.id, n).catch(() => null)) ?? (await fromResult(t, d, n));
      if (!src) {
        save({ ...d, pending: null });
        return `${label}: its worker finished without writing version ${n} (drawings/${d.id}/v${n}.*). Its headline was: ${t.headline ?? "none"}. Tell the user it didn't come out, and offer to try again.`;
      }
      const kind = kindOf(src.ext) ?? "svg";
      let svg: string;
      try {
        svg = await render.svg(kind, src.text);
      } catch (e) {
        const error = errorText(e);
        if (!d.pending.fixed && t.runner === "session" && t.instanceId) {
          save({ ...d, pending: { ...d.pending, fixed: true } });
          try {
            await tasks.followup(t.id, fixPrompt(d, n, src.path, error));
            return false;
          } catch {
            // Its session is gone: report it.
          }
        }
        save({ ...d, pending: null });
        return `${label}: version ${n} didn't render (${error}), even after a fix. Tell the user it failed, and offer to try again.`;
      }
      const base = `${slug(d.title)}-v${n}`;
      const png = await render
        .png(svg)
        .then((b) => (b ? backend.store(`${base}.png`, b) : null))
        .catch(() => null);
      const svgRef = await backend.store(`${base}.svg`, new Blob([svg], { type: "image/svg+xml" })).catch(() => null);
      svgs.set(`${d.id}:${n}`, svg);
      const version: Version = {
        n,
        ext: src.ext,
        path: src.path,
        workspace: t.workspace,
        folder: t.folder,
        taskId: t.id,
        headline: t.headline ?? "",
        at: now(),
        png: plain(png),
        svg: plain(svgRef),
      };
      const done = save({ ...d, kind, versions: [...d.versions, version], pending: null }, d.surface ?? undefined);
      deps.notice(d.threadId, {
        kind: "drawing",
        text: `${d.title} · v${n}`,
        drawing: { id: d.id, n, title: d.title, png },
      });
      const where = done.surface === "phone" ? ", open on the user's phone" : "";
      const headline = (t.headline ?? "").trim().replace(/\.$/, "");
      return `${label}, version ${n}, is drawn${headline ? `: ${headline}` : ""}. It's on the canvas${where}. Tell the user in a few words where it is ("It's on the canvas"); describe it only if they ask. Changes go to draw with drawing "${d.id}".`;
    },

    keepWarm(t) {
      if (t.kind !== "drawing") return false;
      return [...shown.values()].some((id) => drawings.get(id)?.threadId === t.threadId);
    },

    viewing(surface, drawingId) {
      if (drawingId) shown.set(surface, drawingId);
      else shown.delete(surface);
    },

    get: (id) => drawings.get(id),
    list: (threadId) =>
      [...drawings.values()].filter((d) => !threadId || d.threadId === threadId).sort((a, b) => b.created - a.created),
    view,

    async svg(id, n) {
      const key = `${id}:${n}`;
      const cached = svgs.get(key);
      if (cached) return cached;
      const d = drawings.get(id);
      const v = d?.versions.find((x) => x.n === n);
      if (!d || !v) throw new Error(`There is no version ${n} of drawing ${id}.`);
      const src = await backend.source(v.workspace, v.folder, id, n);
      if (!src) throw new Error(`Version ${n}'s source is gone (${v.path}).`);
      const svg = await render.svg(kindOf(src.ext) ?? "svg", src.text);
      svgs.set(key, svg);
      return svg;
    },

    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    dispose() {
      offTasks();
      listeners.clear();
    },
  };
  return api;
}

const base64 = async (b: Blob) => {
  const bytes = new Uint8Array(await b.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** How many records are loaded at start. */
const LOAD_LIMIT = 300;

export const ipcDrawingBackend: DrawingBackend = {
  put: (d) => drawingPut(d.id, JSON.stringify(d)),
  async list() {
    return (await drawingList(LOAD_LIMIT)).flatMap((r) => {
      try {
        const d = Drawing.safeParse(JSON.parse(r));
        return d.success ? [d.data] : [];
      } catch {
        return [];
      }
    });
  },
  source: drawingSource,
  write: drawingWrite,
  resultMd: async (workspace, folder) => (await taskResult(workspace, folder)).md,
  store: async (name, data) => attachBytes(name, await base64(data)),
};
