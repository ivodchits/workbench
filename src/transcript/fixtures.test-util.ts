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
