// The T0 fixtures (`src-tauri/src/transcript/fixtures`), loaded as raw text so the
// tests need neither Node's `fs` nor its types.

const raw = import.meta.glob<string>("../../src-tauri/src/transcript/fixtures/*.jsonl", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Fixture name (`01-text-turn`) → its lines. */
export const fixtures: Record<string, string[]> = Object.fromEntries(
  Object.entries(raw)
    .map(([path, text]): [string, string[]] => [
      path.replace(/^.*\//, "").replace(/\.jsonl$/, ""),
      text.split("\n").filter((l) => l.trim()),
    ])
    .sort(([a], [b]) => a.localeCompare(b)),
);

/** The scenarios cut from the one T0 session, in order: `01` … `15`. */
export const sessionNames = Object.keys(fixtures).filter(
  (n) => !n.includes("sidechain") && !n.startsWith("16"),
);

/** The whole T0 session, as its transcript file had it. */
export const sessionLines = sessionNames.flatMap((n) => fixtures[n]);

/** A browser screenshot's call and its result: some text and two pictures, the way
 *  an MCP tool returns them (and one block of a type we don't show). */
export const screenshotLines = [
  JSON.stringify({
    type: "assistant",
    uuid: "a1",
    timestamp: "2026-11-24T10:00:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_shot", name: "mcp__firefox__tabs_capture_screenshot", input: { tabId: 3 } }],
    },
  }),
  JSON.stringify({
    type: "user",
    uuid: "u1",
    timestamp: "2026-11-24T10:00:01.000Z",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_shot",
          content: [
            { type: "text", text: "Captured 2 screenshots" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQ" } },
            { type: "image", source: { type: "base64", media_type: "image/svg+xml", data: "PHN2Zz4=" } },
          ],
        },
      ],
    },
    toolUseResult: [{ type: "text", text: "Captured 2 screenshots" }],
  }),
];

/** A `show_media` call (S2) and its answer, ending with the `media:` line. */
export function showMediaLines(result: string, isError = false): string[] {
  return [
    JSON.stringify({
      type: "assistant",
      uuid: "sm-a",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_show", name: "mcp__workbench__show_media", input: { paths: ["C:/out/chart.png", "clip.mp4"], caption: " the chart " } }],
      },
    }),
    JSON.stringify({
      type: "user",
      uuid: "sm-u",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_show", content: [{ type: "text", text: result }], ...(isError && { is_error: true }) }] },
    }),
  ];
}
