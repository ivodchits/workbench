// Duck's screenshots (step V3): "take a screenshot and read me the error". The
// capture (`src-tauri/src/voice/screen.rs`) comes back downscaled as PNG and goes
// to the model as image blocks, with the list of monitors so "the right monitor"
// resolves. Nothing is written to disk unless you ask to save it. Each capture
// shows a line in the thread ("▣ screenshot: monitor 2 (right)").

import { z } from "zod";
import type { Capture, MonitorInfo, ScreenTarget } from "../../ipc/screen";
import { defineTool } from "./registry";

/** The screen as the tools reach it: the app's commands, fakes in tests. */
export interface ScreenHost {
  capture(target: ScreenTarget): Promise<Capture>;
  monitors(): Promise<MonitorInfo[]>;
  /** Write the last capture to the user's pictures; the files. */
  save(): Promise<string[]>;
}

const POSITIONS = ["left", "middle", "right", "main"] as const;

/** A monitor named by number (1 is the leftmost) or by where it is. */
export function pickMonitor(monitors: MonitorInfo[], ref: string): number {
  const r = ref.trim().toLowerCase();
  const list = monitors.map((m) => `${m.number} (${m.position}${m.main ? ", main" : ""})`).join(", ");
  const n = Number(r);
  const hit = Number.isInteger(n)
    ? monitors.find((m) => m.number === n)
    : r === "main" || r === "primary"
      ? monitors.find((m) => m.main)
      : r === "center" || r === "centre"
        ? monitors.find((m) => m.position === "middle")
        : monitors.find((m) => m.position === r || (monitors.length === 1 && POSITIONS.includes(r as never)));
  if (!hit) throw new Error(`no monitor "${ref}"; the monitors are ${list || "none"}.`);
  return hit.number;
}

function describeMonitors(ms: MonitorInfo[]): string {
  return ms.map((m) => `${m.number}: ${m.position}${m.main ? ", main" : ""}, ${m.width}x${m.height}${m.name ? `, ${m.name}` : ""}`).join("; ");
}

export const screenshotTool = defineTool({
  name: "screenshot",
  description:
    "Take a screenshot and look at it: the active window (the app in front, or the frontmost other app when Workbench is in front), one monitor, a window by its title, or all monitors (one image each). Use it for \"what's on my screen\", \"read me the error\", \"what does the right monitor show\". Monitors are numbered left to right; name one by number or as left / middle / right / main. Read text in the image yourself; when the user wants it read aloud, use read_aloud with source \"text\" for anything longer than a few sentences. Nothing is saved unless save_screenshot is called.",
  schema: z.object({
    target: z.enum(["active_window", "monitor", "window", "all"]),
    monitor: z.string().optional().describe('For target "monitor": a number (1 is the leftmost) or left / middle / right / main.'),
    title: z.string().optional().describe('For target "window": part of its title or its app\'s name.'),
  }),
  tier: "read",
  timeoutMs: 20_000,
  async run({ target, monitor, title }, ctx) {
    if (!ctx.screen) throw new Error("Screenshots aren't available here.");
    let t: ScreenTarget;
    if (target === "monitor") {
      if (!monitor) throw new Error('target "monitor" needs `monitor`.');
      t = { kind: "monitor", number: pickMonitor(await ctx.screen.monitors(), monitor) };
    } else if (target === "window") {
      if (!title?.trim()) throw new Error('target "window" needs `title`.');
      t = { kind: "window", title };
    } else t = { kind: target === "all" ? "all" : "activeWindow" };
    const cap = await ctx.screen.capture(t);
    await ctx.notice({ kind: "screen", text: `screenshot: ${cap.shots.map((s) => s.label).join(", ")}` });
    return [
      {
        type: "text" as const,
        text: `Captured ${cap.shots.map((s) => `${s.label} (${s.sourceWidth}x${s.sourceHeight}, sent at ${s.width}x${s.height})`).join("; ")}. Monitors: ${describeMonitors(cap.monitors)}.`,
      },
      ...cap.shots.map((s) => ({
        type: "image" as const,
        source: { type: "base64" as const, media_type: "image/png" as const, data: s.pngBase64 },
      })),
    ];
  },
});

export const saveScreenshot = defineTool({
  name: "save_screenshot",
  description: "Save the last screenshot, at full size, as PNG in the user's Pictures\\Workbench folder. Only when the user asks to keep it.",
  schema: z.object({}),
  tier: "reversible",
  async run(_, ctx) {
    if (!ctx.screen) throw new Error("Screenshots aren't available here.");
    return { saved: await ctx.screen.save() };
  },
});

export const SCREENSHOT_TOOLS = [screenshotTool, saveScreenshot];
