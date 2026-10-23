// Drawing (step G3): Duck writes a brief, a worker on the subscription draws, and
// the drawing lands on the canvas. Duck's own cost is the brief and the report;
// the work is `drawings.ts`'s.

import { z } from "zod";

import { MAX_ATTACHMENTS } from "../attachments";
import type { Drawings } from "../drawings";
import { DRAWING_KINDS } from "../../drawing/kinds";
import { compact } from "./read";
import { defineTool, type ToolContext } from "./registry";

function drawings(ctx: ToolContext): Drawings {
  if (!ctx.drawings) throw new Error("Drawing isn't available here.");
  return ctx.drawings;
}

export const draw = defineTool({
  name: "draw",
  description: [
    "Draw a diagram, schema, wireframe, chart or sketch, or change one: a drawing worker on the user's subscription writes it and it appears on the canvas beside the thread (no API cost beyond this call). It returns at once; when the drawing is ready you get a <workbench_event>, and then you tell the user it's on the canvas.",
    "Draw when the user asks for a picture of something. Offer one (don't just draw) when it would clearly help, at most once per topic.",
    "`brief`: what to draw for someone who hasn't seen this conversation: the parts, how they connect, the labels, and any numbers (a chart's data, in full). `kind`: mermaid (flowcharts, sequence, state, ER, gantt, timeline; how something travels between parties, a request or a message, is a sequence diagram; a sketch is a flowchart or state diagram with \"hand-drawn look\" in the brief, never a sequence diagram, which has no hand-drawn look), svg (wireframes, schemas, illustrations), vega (charts from numbers); leave it out to let the worker choose.",
    "`drawing`: the id of an existing drawing (from its card or an earlier event) to change it: the brief then says only what changes, and it becomes the next version.",
    "`tier`: standard; involved for \"carefully\" or a schema with many parts. `allowApi`: only when the user says to draw now on the API although the subscription's limits are close (otherwise a drawing waits for the window).",
  ].join(" "),
  schema: z.object({
    title: z.string().trim().min(1).max(60).describe("A short name for the drawing, on its card. For an edit, the drawing's title."),
    brief: z.string().trim().min(1).max(20_000),
    kind: z.enum(DRAWING_KINDS).optional(),
    drawing: z.string().trim().min(1).optional().describe("An existing drawing's id, to change it."),
    tier: z.enum(["standard", "involved"]).default("standard"),
    files: z.array(z.string().trim().min(1)).max(MAX_ATTACHMENTS).optional().describe("Attachment ids the worker should look at (a sketch, a screenshot)."),
    allowApi: z.boolean().optional(),
  }),
  tier: "reversible",
  // Making the folder and starting the worker; the drawing itself is reported later.
  timeoutMs: 30_000,
  describe({ title, drawing }) {
    return drawing ? `Change the drawing "${title}"` : `Draw "${title}"`;
  },
  async run({ title, brief, kind, drawing, tier, files, allowApi }, ctx) {
    const d = drawings(ctx);
    const refs = [...new Set(files ?? [])].map((id) => {
      const f = ctx.attachment?.(id);
      if (!f) throw new Error(`There is no file ${id} in this thread: use the id from its <attachment> tag.`);
      return f;
    });
    const r = await d.draw({
      threadId: ctx.threadId,
      title,
      brief,
      kind,
      tier,
      drawing,
      allowApi,
      surface: ctx.surface,
      mandate: ctx.request ?? undefined,
      ...(refs.length && { files: refs }),
    });
    const n = r.drawing.pending?.n ?? 1;
    const waiting = r.task.state === "queued" ? r.task.why : null;
    return compact({
      drawing: r.drawing.id,
      version: n,
      task: r.task.id,
      worker: r.how === "followup" ? "the thread's drawing worker (warm)" : "a new drawing worker",
      waiting,
      note: waiting
        ? "It waits: tell the user why in a sentence."
        : "Drawing. Say so in a few words if the user is waiting (\"Drawing it now\"); the result comes as an event.",
    });
  },
});

export const DRAW_TOOLS = [draw];
