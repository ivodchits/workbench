// The sidebar's Duck chat (office plan O3.1): what opens when you click Duck. A thread
// picker and a new thread, the conversation, Duck's reply as it streams, its cards to
// allow or deny, and a composer with stop.
//
// The phone's pieces do the work: Duck's socket on the office's listener speaks the
// phone's Duck Protocol (`/office/api/assistant`, as the device `office`, which the
// webview takes for you at the desktop), its frames fold into the phone's store
// (`pwa/duckStore.ts`), and messages become the desktop's items (`toItems`) and
// markdown. Leaner than the phone's: no mic, no voice, no files, no settings. The
// socket is open only while the chat is. What Duck does in the thread on screen goes
// to `onTurn`, for Duck's animation in the office.

import "../theme/markdown.css";
import type { ConfirmRequest, TurnState } from "../assistant/protocol";
import { oneLine, readableInput, toItems, type Item } from "../panels/Assistant/view";
import { renderMarkdown } from "../panels/Editor/markdown";
import type { RemoteDuckFrame, RemoteDuckMessage } from "../remote/protocol";
import { el } from "../pwa/dom";
import { keepingSelection } from "../util/keepSelection";
import { apply, emptyView, type DuckView } from "../pwa/duckStore";
import type { Link } from "./net";

/** Closer than this to the end counts as "at the bottom". */
const STICK_PX = 48;
const RECONNECT_MS = 2000;
/** The thread last on screen, for the next time the chat opens. */
const THREAD_KEY = "wb-office-duck-thread";

const STATE_LABEL: Record<TurnState, string> = {
  idle: "",
  thinking: "thinking…",
  streaming: "replying…",
  tool: "running a tool…",
  waiting: "waiting for your answer",
};

export interface DuckChat {
  /** Open (connecting) or close (disconnecting) the chat. */
  show(open: boolean): void;
}

function saved(): string | null {
  try {
    return localStorage.getItem(THREAD_KEY);
  } catch {
    return null;
  }
}

function remember(id: string | null): void {
  try {
    if (id) localStorage.setItem(THREAD_KEY, id);
    else localStorage.removeItem(THREAD_KEY);
  } catch {
    // No storage: the chat opens on the latest thread.
  }
}

/** The chat in `root`; ✕ calls `onClose`. `onTurn` hears the state of the thread on
 *  screen (idle when closed). */
export function createDuckChat(root: HTMLElement, link: Link, onClose: () => void, onTurn: (state: TurnState) => void): DuckChat {
  const close = el("button", "close", "✕");
  close.title = "close (Esc)";
  const fresh = el("button", "new", "new thread");
  const pick = el("select", "threads");
  pick.title = "Duck's threads";
  const head = el("header");
  head.append(close, el("h2", "", "Duck"), pick, fresh);
  const state = el("p", "state");

  const scroll = el("div", "scroll");
  const list = el("div");
  const streaming = el("div", "wb-md duck-reply");
  /** What `streaming` shows, so an unchanged paint leaves its nodes alone. */
  let streamed = "";
  scroll.append(list, streaming);
  const asks = el("div", "asks");
  const error = el("p", "error");

  const text = el("textarea");
  text.rows = 3;
  text.placeholder = "ask Duck… (Enter sends, Shift+Enter a new line)";
  const stop = el("button", "stop", "stop");
  const send = el("button", "send", "send");
  const buttons = el("div", "buttons");
  buttons.append(stop, send);
  const composer = el("div", "composer");
  composer.append(text, buttons);
  for (const b of [close, fresh, stop, send]) b.type = "button";

  root.replaceChildren(head, state, scroll, asks, error, composer);

  let view: DuckView = emptyView();
  let ws: WebSocket | null = null;
  let shown = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  /** A send with no thread waits for the new one, which becomes the thread on screen. */
  let adopting = false;
  let stuck = true;
  let turn: TurnState = "idle";

  const post = (m: RemoteDuckMessage) => (ws?.readyState === WebSocket.OPEN ? (ws.send(JSON.stringify(m)), true) : false);
  const toEnd = () => void (scroll.scrollTop = scroll.scrollHeight);
  const current = () => view.current;
  const stateOf = (): TurnState => (current() ? (view.states[current()!] ?? "idle") : "idle");

  function connect(): void {
    if (ws || !shown) return;
    const socket = link.socket("assistant", {});
    if (!socket) return paintError("Not signed in to Workbench.");
    ws = socket;
    state.textContent = "connecting…";
    socket.onopen = () => {
      view = { ...view, synced: false };
      post({ type: "sync" });
      if (current()) post({ type: "thread.open", threadId: current()! });
      paint();
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      if (!shown) return;
      state.textContent = "Duck can't be reached. Trying again…";
      retry = setTimeout(connect, RECONNECT_MS);
    };
    socket.onerror = () => socket.close();
    socket.onmessage = (e) => {
      try {
        onFrame(JSON.parse(String(e.data)) as RemoteDuckFrame);
      } catch {
        // Not a frame.
      }
    };
  }

  function disconnect(): void {
    clearTimeout(retry);
    const socket = ws;
    ws = null;
    socket?.close();
  }

  function onFrame(f: RemoteDuckFrame): void {
    const before = view;
    const r = apply(view, f, adopting);
    view = r.view;
    if (r.adopted) {
      adopting = false;
      remember(view.current);
    }
    if (r.fx.open) openThread(r.fx.open);
    if (r.fx.refetch && current()) post({ type: "thread.open", threadId: current()! });
    if (f.type === "threads" && !before.synced) {
      const want = [current(), saved()].find((id) => id && view.threads.some((t) => t.id === id));
      return openThread(want ?? view.threads[0]?.id ?? null);
    }
    paint(before);
  }

  function openThread(id: string | null): void {
    view = { ...view, current: id };
    remember(id);
    stuck = true;
    if (id) post({ type: "thread.open", threadId: id });
    paint();
  }

  function submit(): void {
    const body = text.value.trim();
    if (!body) return;
    if (current() === null) adopting = true;
    if (!post({ type: "send", threadId: current(), text: body })) {
      adopting = false;
      return paintError("Not connected: try again in a moment.");
    }
    text.value = "";
    stuck = true;
  }

  function paintError(message: string | null): void {
    error.textContent = message ?? "";
    error.hidden = !message;
  }

  /** Repaints what changed since `before` (everything without it). */
  function paint(before?: DuckView): void {
    const id = current();
    const threads = JSON.stringify(view.threads.map((t) => [t.id, t.title]));
    if (pick.dataset.key !== threads || pick.value !== (id ?? "")) {
      pick.dataset.key = threads;
      pick.replaceChildren(new Option("a new thread", ""), ...view.threads.map((t) => new Option(t.title || "untitled", t.id)));
      pick.value = id ?? "";
    }
    const s = stateOf();
    const live = id ? (view.streaming[id] ?? "") : "";
    // A selection in the chat survives the list being rebuilt and the reply growing.
    keepingSelection(scroll, () => {
      if (!before || before.current !== id || (id && (before.messages[id] !== view.messages[id] || (before.states[id] ?? "idle") !== s)))
        paintItems();
      streaming.hidden = !live;
      if (live && live !== streamed) streaming.innerHTML = renderMarkdown(live); // sanitized by DOMPurify in renderMarkdown
      streamed = live;
    });
    if (!before || before.asks !== view.asks || before.current !== id) paintAsks();
    if (ws?.readyState === WebSocket.OPEN) state.textContent = view.synced ? STATE_LABEL[s] || "here" : "loading…";
    state.className = `state turn-${s}`;
    stop.hidden = s === "idle";
    paintError(view.error);
    if (stuck) toEnd();
    if (s !== turn) onTurn((turn = s));
  }

  function paintItems(): void {
    const id = current();
    if (!id) return list.replaceChildren(el("p", "muted empty", "A new thread. Ask Duck anything about your sessions."));
    const messages = view.messages[id];
    if (!messages) return list.replaceChildren(el("p", "muted empty", "loading…"));
    const active = stateOf() !== "idle";
    list.replaceChildren(...toItems(messages).map((it) => itemView(it, active)));
  }

  function paintAsks(): void {
    const here = view.asks.filter((a) => a.threadId === current());
    const elsewhere = view.asks.filter((a) => a.threadId !== current());
    const parts: HTMLElement[] = here.map(askCard);
    if (elsewhere.length) {
      const b = el("button", "elsewhere", `● ${elsewhere.length} waiting in ${view.threads.find((t) => t.id === elsewhere[0].threadId)?.title || "another thread"}: open`);
      b.type = "button";
      b.onclick = () => openThread(elsewhere[0].threadId);
      parts.push(b);
    }
    asks.replaceChildren(...parts);
    asks.hidden = !parts.length;
  }

  function askCard(ask: ConfirmRequest): HTMLElement {
    const card = el("div", "ask");
    const what = el("div");
    what.append(el("span", "needs-text", "● Duck wants to run "), el("strong", "", ask.name));
    card.append(what);
    if (ask.summary) card.append(el("div", "", ask.summary));
    card.append(el("pre", "input", readableInput(ask.input)));
    const bar = el("div", "buttons");
    const yes = ask.choices?.length ? ask.choices : [{ id: "", label: "allow" }];
    const all = [...yes.map((c) => ({ b: el("button", "ok", c.label), allow: true, choice: c.id })), { b: el("button", "no", ask.denyLabel ?? "deny"), allow: false, choice: "" }];
    for (const { b, allow, choice } of all) {
      b.type = "button";
      b.onclick = () => {
        for (const x of all) x.b.disabled = true;
        post({ type: "confirm", threadId: ask.threadId, toolUseId: ask.toolUseId, allow, ...(choice && { choice }) });
      };
    }
    bar.append(...all.map((x) => x.b));
    card.append(bar);
    return card;
  }

  scroll.addEventListener("scroll", () => (stuck = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < STICK_PX), { passive: true });
  // Rendered links are untrusted text: only web and mail links go anywhere.
  scroll.addEventListener("click", (e) => {
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (a && !/^(https?:|mailto:)/i.test(a.getAttribute("href") ?? "")) e.preventDefault();
  });
  pick.addEventListener("change", () => openThread(pick.value || null));
  fresh.onclick = () => {
    openThread(null);
    text.focus();
  };
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  send.onclick = submit;
  stop.onclick = () => void (current() && post({ type: "stop", threadId: current()! }));
  close.onclick = onClose;

  return {
    show(open) {
      if (open === shown) return;
      shown = open;
      root.hidden = !open;
      if (open) {
        stuck = true;
        connect();
        paint();
        text.focus();
      } else {
        disconnect();
        if (turn !== "idle") onTurn((turn = "idle"));
      }
    },
  };
}

/** One item of the conversation. */
function itemView(it: Item, active: boolean): HTMLElement {
  switch (it.kind) {
    case "user":
      return el("div", "duck-user", it.text);
    case "reply": {
      const r = el("div", "wb-md duck-reply");
      r.innerHTML = renderMarkdown(it.text); // sanitized by DOMPurify in renderMarkdown
      return r;
    }
    case "tool": {
      const r = it.result;
      const chip = el("div", "duck-tool");
      chip.append(
        el("span", r ? (r.isError ? "needs-text" : "done-text") : "muted", r ? (r.isError ? "✕" : "✓") : active ? "◌" : "–"),
        el("span", "name", it.name),
        el("span", "muted", oneLine(it.input)),
      );
      return chip;
    }
    case "notice":
      return el("div", "duck-event muted", it.notice.text);
    default:
      return el("div", "duck-event muted", it.text);
  }
}
