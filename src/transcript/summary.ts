// One-line summaries of transcript items (step W1, moved out of `render.ts`): what a
// tool call acted on and what to call it. Pure, so the DOM renderer and Duck's
// plain-text reader (`plainText.ts`) share them.

import type { ToolItem } from "./model";

/** The last two segments of a path — enough to recognise a file on one line. */
export function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}

export function oneLine(text: string, max = 140): string {
  const first = text.trim().split("\n")[0] ?? "";
  const more = text.trim().includes("\n");
  return first.length > max
    ? `${first.slice(0, max)}…`
    : more
      ? `${first} …`
      : first;
}

export function inputStr(item: ToolItem, key: string): string {
  const v = item.input[key];
  return typeof v === "string" ? v : "";
}

/** The one-line target of a tool call: what it acted on. */
export function toolTarget(item: ToolItem): string {
  switch (item.name) {
    case "Bash":
      return oneLine(inputStr(item, "command"));
    case "Edit":
    case "Write":
    case "Read":
    case "NotebookEdit":
      return shortPath(
        inputStr(item, "file_path") || inputStr(item, "notebook_path"),
      );
    case "Grep": {
      const where = inputStr(item, "path") || inputStr(item, "glob");
      return `${inputStr(item, "pattern")}${where ? `  in ${shortPath(where)}` : ""}`;
    }
    case "Glob":
      return inputStr(item, "pattern");
    case "Agent":
    case "Task":
      return item.agent?.description ?? "";
    case "AskUserQuestion": {
      const q = item.questions?.[0];
      if (!q) return "";
      const extra =
        (item.questions?.length ?? 1) > 1
          ? ` (+${(item.questions?.length ?? 1) - 1})`
          : "";
      return q.answer === null
        ? `${q.question}${extra}`
        : `${q.question} → ${q.answer}${extra}`;
    }
    case "ExitPlanMode":
      return oneLine(inputStr(item, "plan").replace(/^#+\s*/, ""));
    case "WebFetch":
      return inputStr(item, "url");
    case "WebSearch":
    case "ToolSearch":
      return inputStr(item, "query");
    case "Skill":
      return inputStr(item, "skill");
    default: {
      // Unknown tool: the first short string argument usually names its target.
      const first = Object.values(item.input).find(
        (v) => typeof v === "string" && v.length > 0,
      );
      return typeof first === "string" ? oneLine(first, 100) : "";
    }
  }
}

export function toolTitle(item: ToolItem): string {
  if (item.agent) return item.agent.type || "Agent";
  if (item.name === "AskUserQuestion") return "Question";
  if (item.name === "ExitPlanMode") return "Plan";
  // `mcp__server__tool` reads better as `server: tool`.
  const mcp = /^mcp__(.+?)__(.+)$/.exec(item.name);
  return mcp ? `${mcp[1]}: ${mcp[2]}` : item.name;
}
