// The trust watcher (step T2): sessions keep working while you're away. Every
// Claude Code permission prompt that opens is decided under the trust policy
// (`session.ts`, then `judge.ts`):
//
//   allow  answered with "Yes" (once), found by its label among the options read
//          off the screen, never by position and never "don't ask again". If the
//          options don't look like the prompt we know, it asks instead.
//   deny   (a rule) Esc, and a word in the thread that started the session.
//   ask    the usual needs-you: toast, push, the card.
//
// Answered as data first (step T4): while the watcher runs, the backend holds each
// permission prompt's `PermissionRequest` hook response, and Claude Code draws no
// menu meanwhile. An allow or a deny goes back as the hook's decision (a deny with
// its reason, which the model reads); anything else releases the hold at once with
// no decision, so the menu shows as before. Keys stay the fallback: for a prompt
// that wasn't held, or whose hold timed out before the decision landed.
//
// The needs-you alerts wait for the decision (`holdNeedsYou`), so a prompt answered
// here bothers no one. A prompt you answer first, or that closes before the decision
// lands, is left alone and logged as `superseded`. Every decision except "trust
// doesn't apply" goes to the log and leaves a line under the session's card.
//
// Questions and plans are T3's (`delegate.ts`); their needs-you waits on its hold
// (`holdOther`).

import type { DecisionRow } from "../../ipc/assistant";
import type { ChoiceRef, SessionContext, SessionRef, WorkbenchPort } from "../port";
import type { Decision } from "./decide";
import { cutFields, judge, type JudgeCall, type Judgement } from "./judge";
import {
  callLine,
  decidePrompt,
  pickYes,
  sessionKey,
  type PromptRequest,
} from "./session";
import { RATE_LIMIT, type TrustStore } from "./store";

/** How long the options get to be read off the screen (`pendingChoice`'s reads end
 *  at 3.5 s). */
export const OPTIONS_WAIT_MS = 5_000;
/** How long a needs-you waits for its prompt to show up in the choice store (the
 *  status engine and the choice store hear the same hook in either order). */
export const PROMPT_WAIT_MS = 1_500;
/** One judge call's limit. */
export const JUDGE_TIMEOUT_MS = 20_000;
/** This many high-risk verdicts in a row on one session trips its rate guard. */
export const HIGH_STREAK = 3;

export interface WatcherDeps {
  port: WorkbenchPort;
  trust: TrustStore;
  judge: JudgeCall;
  /** Show a notice in one of Duck's threads. */
  notice(threadId: string, text: string): void;
  /** Answer prompts (the setting); false keeps every project in shadow mode. */
  answering?: () => boolean;
  /** The hold for a question's or a plan's needs-you (T3's delegate watcher). */
  holdOther?: (instanceId: string) => Promise<boolean>;
  now?: () => number;
  optionsWaitMs?: number;
  promptWaitMs?: number;
}

const EMPTY_CONTEXT: SessionContext = { mandate: null, from: null, threadId: null, lastPrompt: null, home: null, delegated: false };

const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;

/** Resolves with the session's prompt once `ok` holds for it (or it's gone), or
 *  with what it is when `ms` runs out. */
export function waitForChoice(
  port: Pick<WorkbenchPort, "choiceOf" | "onChoices">,
  id: string,
  ok: (c: ChoiceRef | null) => boolean,
  ms: number,
): Promise<ChoiceRef | null> {
  return new Promise((resolve) => {
    const check = () => {
      const c = port.choiceOf(id);
      if (!ok(c)) return false;
      done(c);
      return true;
    };
    const done = (c: ChoiceRef | null) => {
      off();
      clearTimeout(timer);
      resolve(c);
    };
    const off = port.onChoices(() => void check());
    const timer = setTimeout(() => done(port.choiceOf(id)), ms);
    check();
  });
}

export function startTrustWatcher(deps: WatcherDeps): () => void {
  const { port, trust } = deps;
  const now = deps.now ?? Date.now;
  const optionsWait = deps.optionsWaitMs ?? OPTIONS_WAIT_MS;
  const promptWait = deps.promptWaitMs ?? PROMPT_WAIT_MS;

  /** The prompt being decided per session, and whether to tell you about it. */
  const handling = new Map<string, { choiceId: string; tell: Promise<boolean> }>();
  /** Needs-you alerts waiting for their prompt to be picked up. */
  const waiting = new Map<string, ((tell: Promise<boolean>) => void)[]>();
  const highStreak = new Map<string, number>();
  let stopped = false;

  function log(s: SessionRef, choice: ChoiceRef, d: Decision, answeredBy: DecisionRow["answeredBy"] = null): void {
    const row: Omit<DecisionRow, "id"> = {
      ts: now(),
      threadId: sessionKey(s.id),
      toolUseId: choice.id,
      projectId: s.projectId,
      tool: choice.toolName,
      summary: `${s.title} · ${callLine(choice.toolName, choice.input)}`,
      input: cutFields(choice.input),
      decision: d.outcome,
      layer: d.layer,
      reason: d.reason,
      ruleId: d.ruleId ?? null,
      shadow: d.shadow,
      answeredBy,
    };
    void trust.log(row).catch((e: unknown) => console.warn("duck: a prompt decision wasn't logged", e));
  }

  /** Tell the thread that started the session, and the card. */
  function say(s: SessionRef, ctx: SessionContext, text: string, acted: boolean): void {
    port.noteSession(s.id, { text, acted });
    if (ctx.threadId && acted) deps.notice(ctx.threadId, `${s.title}: ${text}`);
  }

  async function judged(req: PromptRequest, s: SessionRef, ctx: SessionContext, shadow: boolean): Promise<Decision> {
    if (!ctx.mandate)
      return { outcome: "ask", layer: "mandate", reason: "the session's task isn't known (no first prompt)", shadow };
    const project = port.listProjects().find((p) => p.id === s.projectId);
    const nearby = trust
      .config()
      .rules.filter((r) => (r.projectId === null || r.projectId === s.projectId) && r.pattern.startsWith(`${req.tool}(`))
      .slice(0, 10)
      .map((r) => `${r.effect} ${r.pattern}`);
    let j: Judgement;
    try {
      j = await judge(
        {
          project: project?.name ?? "?",
          root: req.root,
          mandate: ctx.mandate,
          lastPrompt: ctx.lastPrompt,
          tool: req.tool,
          input: req.input,
          nearby,
        },
        deps.judge,
        AbortSignal.timeout(JUDGE_TIMEOUT_MS),
      );
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return { outcome: "ask", layer: "judge", reason: `the judge failed: ${why}`, shadow };
    }
    const high = j.first.risk === "high" || j.second?.risk === "high";
    const streak = high ? (highStreak.get(s.id) ?? 0) + 1 : 0;
    highStreak.set(s.id, streak);
    if (streak >= HIGH_STREAK && !shadow) {
      trust.trip(sessionKey(s.id));
      highStreak.delete(s.id);
      say(s, ctx, `trust paused for this session: ${HIGH_STREAK} high-risk prompts in a row`, true);
    }
    return { outcome: j.outcome, layer: "judge", reason: j.reason, shadow };
  }

  /** Let a held prompt's menu show: nothing here will answer it. */
  function release(s: SessionRef, choice: ChoiceRef): void {
    if (choice.held) void port.answerHeld(s.id, choice.id, null);
  }

  /** Decide one prompt; resolves to whether to tell you. A held prompt is always
   *  answered or released by the time it resolves. */
  async function handle(s: SessionRef, choice: ChoiceRef): Promise<boolean> {
    try {
      return await decideOne(s, choice);
    } finally {
      release(s, choice); // a no-op once answered
    }
  }

  async function decideOne(s: SessionRef, choice: ChoiceRef): Promise<boolean> {
    const ctx = await port.sessionContext(s.id).catch(() => EMPTY_CONTEXT);
    const req: PromptRequest = {
      instanceId: s.id,
      projectId: s.projectId,
      tool: choice.toolName,
      input: choice.input,
      root: s.workingDir,
      home: ctx.home ?? undefined,
    };
    const first = decidePrompt(req, trust.config());
    if (!first) return true;
    const shadow = first.shadow || !(deps.answering?.() ?? true);
    // Only logged: don't keep the menu waiting for the judge.
    if (shadow) release(s, choice);
    let d = first.outcome === "judge" ? await judged(req, s, ctx, shadow) : { ...first, shadow };
    const what = code(callLine(choice.toolName, choice.input).replace(/^Bash: /, ""));
    const gone = (c: ChoiceRef | null) => !c || c.id !== choice.id || c.sent !== null;

    if (d.shadow) {
      log(s, choice, d);
      port.noteSession(s.id, { text: `would ${d.outcome} ${what} (shadow)`, acted: false });
      return true;
    }
    if (d.outcome === "allow" && trust.approved(sessionKey(s.id), now())) {
      d = { ...d, outcome: "ask", layer: "rate", reason: `more than ${RATE_LIMIT} automatic approvals in 10 minutes` };
      say(
        s,
        ctx,
        `trust paused for this session: more than ${RATE_LIMIT} prompts approved on Duck's own in 10 minutes. Pause and resume trust to reset it.`,
        true,
      );
    }
    if (d.outcome === "ask") {
      if (gone(port.choiceOf(s.id))) {
        log(s, choice, { ...d, layer: "superseded", reason: `answered first; would have asked (${d.reason})` });
        return true;
      }
      log(s, choice, d);
      port.noteSession(s.id, { text: `left to you: ${what} (${d.reason})`, acted: false });
      return true;
    }

    // allow / deny: as the hook's decision while the prompt is held.
    if (choice.held && !gone(port.choiceOf(s.id))) {
      const ok = await port.answerHeld(
        s.id,
        choice.id,
        d.outcome === "allow"
          ? { behavior: "allow" }
          : { behavior: "deny", message: `Refused by the user's trust rules in Workbench: ${d.reason}.` },
      );
      if (ok) {
        log(s, choice, d, "hook");
        if (d.outcome === "allow") port.noteSession(s.id, { text: `auto-approved ${what}`, acted: true });
        else say(s, ctx, `refused ${what} (${d.reason})`, true);
        return false;
      }
      // The hold timed out (or you answered on the card): the menu, or nothing.
    }

    // allow / deny: press a key, if the prompt is still the one decided.
    let key: number | "deny" = "deny";
    if (d.outcome === "allow") {
      const c = await waitForChoice(port, s.id, (x) => gone(x) || pickYes(x!) !== null, optionsWait);
      if (gone(c)) {
        log(s, choice, { ...d, layer: "superseded", reason: `answered first; would have allowed (${d.reason})` });
        return true;
      }
      const yes = pickYes(c!);
      if (yes === null) {
        log(s, choice, { ...d, outcome: "ask", reason: `would allow (${d.reason}), but the prompt's options weren't the known Yes / No` });
        port.noteSession(s.id, { text: `left to you: ${what} (its options weren't the known ones)`, acted: false });
        return true;
      }
      key = yes;
    }
    if (gone(port.choiceOf(s.id))) {
      log(s, choice, { ...d, layer: "superseded", reason: `answered first; would have ${d.outcome === "allow" ? "allowed" : "refused"} (${d.reason})` });
      return true;
    }
    try {
      port.answerChoice(s.id, choice.id, key);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      log(s, choice, { ...d, layer: "superseded", reason: `not answered: ${why}` });
      return true;
    }
    log(s, choice, d, "keys");
    if (d.outcome === "allow") port.noteSession(s.id, { text: `auto-approved ${what}`, acted: true });
    else say(s, ctx, `refused ${what} (${d.reason})`, true);
    return false;
  }

  function start(s: SessionRef, choice: ChoiceRef): void {
    const tell = handle(s, choice).catch((e: unknown) => {
      console.warn("duck: a permission prompt wasn't decided", e);
      return true;
    });
    handling.set(s.id, { choiceId: choice.id, tell });
    for (const w of waiting.get(s.id) ?? []) w(tell);
    waiting.delete(s.id);
    void tell.finally(() => {
      if (handling.get(s.id)?.choiceId === choice.id) handling.delete(s.id);
    });
  }

  /** The last prompt picked up per session, so each is decided once. */
  const seen = new Map<string, string>();

  const other = (id: string) => deps.holdOther?.(id) ?? Promise.resolve(true);

  /** Pick up every permission prompt that just opened. */
  function scan(): void {
    if (stopped) return;
    for (const s of port.listSessions()) {
      const c = s.choice;
      // A needs-you waiting for a question or a plan: that's the other hold's.
      if (c && c.kind !== "permission" && waiting.has(s.id)) {
        const tell = other(s.id);
        for (const w of waiting.get(s.id) ?? []) w(tell);
        waiting.delete(s.id);
      }
      if (!c || c.kind !== "permission" || c.sent !== null) continue;
      if (handling.get(s.id)?.choiceId === c.id || seen.get(s.id) === c.id) continue;
      seen.set(s.id, c.id);
      start(s, c);
    }
  }
  const hold = (id: string): Promise<boolean> => {
    const h = handling.get(id);
    const c = port.choiceOf(id);
    if (h && (!c || c.id === h.choiceId)) return h.tell;
    if (c && c.kind !== "permission") return other(id);
    if (c && seen.get(id) === c.id) return Promise.resolve(true); // decided already
    // The prompt hasn't reached the choice store yet: wait for it a moment.
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const ws = (waiting.get(id) ?? []).filter((w) => w !== pick);
        if (ws.length) waiting.set(id, ws);
        else waiting.delete(id);
        resolve(true);
      }, promptWait);
      const pick = (tell: Promise<boolean>) => {
        clearTimeout(timer);
        resolve(tell);
      };
      waiting.set(id, [...(waiting.get(id) ?? []), pick]);
      scan();
    });
  };

  const offChoices = port.onChoices(scan);
  const offHold = port.holdNeedsYou(hold);
  port.holdPermissions(true);
  scan();
  return () => {
    stopped = true;
    port.holdPermissions(false);
    offChoices();
    offHold();
  };
}

