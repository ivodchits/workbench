// What kind of work a session's latest tool is (office plan O0.3): the office picks
// where a worker stands from it (the desk, the whiteboard, the newspaper). Pure, so
// the status engine folds it in on each `PreToolUse` and the tests pin it down.

export type Activity = "edit" | "bash" | "test" | "web" | "read" | "task" | "other";

const EDIT = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const SHELL = new Set(["Bash", "PowerShell", "BashOutput", "KillShell", "KillBash", "Monitor"]);
const READ = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead", "LSP"]);
const WEB = new Set(["WebFetch", "WebSearch"]);
const TASK = new Set(["Task", "Agent", "Workflow"]);

/** A command that runs tests: a test runner, or a package script named test. */
const TEST_COMMAND =
  /(^|[\s;&|(])(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|npx\s+(?:vitest|jest|playwright\s+test)\b|vitest\b|jest\b|pytest\b|python[\d.]*\s+-m\s+(?:pytest|unittest)\b|cargo\s+(?:test|nextest)\b|go\s+test\b|dotnet\s+test\b|mvn\b.*\btest\b|gradlew?\b.*\btest\b|rspec\b|phpunit\b|ctest\b)/;

/** The kind of work `toolName` called with `input` is. */
export function toolActivity(toolName: string, input: unknown): Activity {
  if (EDIT.has(toolName)) return "edit";
  if (READ.has(toolName)) return "read";
  if (WEB.has(toolName)) return "web";
  if (TASK.has(toolName)) return "task";
  if (SHELL.has(toolName)) {
    const command = input && typeof input === "object" ? (input as Record<string, unknown>).command : undefined;
    return typeof command === "string" && TEST_COMMAND.test(command) ? "test" : "bash";
  }
  // A browser over MCP is the web too.
  if (toolName.startsWith("mcp__") && /browser|chrome|firefox|playwright|fetch/i.test(toolName)) return "web";
  return "other";
}
