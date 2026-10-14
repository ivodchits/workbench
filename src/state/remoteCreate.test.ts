import { beforeEach, describe, expect, it } from "vitest";

import {
  CREATED_KEEP,
  asksForPassword,
  beginCreate,
  getCreated,
  promptBoxReady,
  resetCreated,
  updateCreate,
} from "./remoteCreate";

const RULE = "─".repeat(100);

/** The screen of a freshly started session (Claude Code 2.1.299), trimmed. */
const READY = [
  " ▐▛███▜▌   Claude Code v2.1.299",
  "▝▜█████▛▘  Opus 5.5 with medium effort · Claude Max",
  "  ▘▘ ▝▝    ~\\repos\\workbench",
  "",
  RULE,
  '❯ Try "fix typecheck errors"',
  RULE,
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
];

/** The workspace trust dialog a folder Claude has not been told to trust shows. */
const TRUST = [
  RULE,
  " Accessing workspace:",
  " C:\\Users\\dev\\fresh-proj",
  " Quick safety check: Is this a project you created or one you trust?",
  "",
  " ❯ 1. Yes, I trust this folder",
  "   2. No, exit",
  "",
  " Enter to confirm · Esc to cancel",
];

describe("request records", () => {
  beforeEach(resetCreated);

  it("takes a request id once", () => {
    expect(beginCreate("r1")).toBe(true);
    expect(beginCreate("r1")).toBe(false);
    expect(getCreated()).toEqual([
      { requestId: "r1", instanceId: null, state: "creating", message: null },
    ]);
  });

  it("refuses an empty id", () => {
    expect(beginCreate("")).toBe(false);
  });

  it("updates a record and ignores an unknown one", () => {
    beginCreate("r1");
    updateCreate("r1", { instanceId: "i1", state: "sent" });
    updateCreate("nope", { state: "failed" });
    expect(getCreated()).toEqual([{ requestId: "r1", instanceId: "i1", state: "sent", message: null }]);
  });

  it("keeps the newest few", () => {
    for (let n = 0; n < CREATED_KEEP + 5; n++) beginCreate(`r${n}`);
    expect(getCreated()).toHaveLength(CREATED_KEEP);
    expect(getCreated()[0].requestId).toBe(`r${CREATED_KEEP + 4}`);
  });
});

describe("promptBoxReady", () => {
  it("sees the empty prompt box", () => {
    expect(promptBoxReady(READY)).toBe(true);
  });

  it("does not take the trust dialog for it", () => {
    expect(promptBoxReady(TRUST)).toBe(false);
  });

  it("does not take a permission prompt for it", () => {
    expect(promptBoxReady([RULE, " Bash command", "", "❯ 1. Yes", "  2. No", RULE])).toBe(false);
    expect(promptBoxReady([RULE, "❯ 1. Yes", RULE])).toBe(false);
  });

  it("needs the rule above and below the caret", () => {
    expect(promptBoxReady(["", "❯ ", RULE])).toBe(false);
    expect(promptBoxReady([RULE, "❯ ", "", "", "", "", "", ""])).toBe(false);
    expect(promptBoxReady([RULE, "❯", RULE])).toBe(true);
  });

  it("is false on a blank or starting screen", () => {
    expect(promptBoxReady([])).toBe(false);
    expect(promptBoxReady(["", "", ""])).toBe(false);
  });
});

describe("asksForPassword", () => {
  it("sees an SSH password or passphrase prompt on the last line", () => {
    expect(asksForPassword(["dev@host's password:", "", ""])).toBe(true);
    expect(asksForPassword(["Enter passphrase for key '/home/dev/.ssh/id_ed25519':"])).toBe(true);
  });

  it("ignores the word elsewhere", () => {
    expect(asksForPassword(["dev@host's password:", "Welcome to Ubuntu"])).toBe(false);
    expect(asksForPassword(READY)).toBe(false);
  });
});
