// `WorkbenchPort` (step A2): the only way Duck touches the app (design → Separable,
// not separate, boundary 1). Duck's tools call this interface, never the stores, so
// lifting Duck out of Workbench later means writing a `port.remote.ts` over the
// remote API and nothing else.
//
// `port.local.ts` is the one implementation today and the only file under
// `src/assistant/` allowed to import `src/state/**` or `src/panels/**`; ESLint
// enforces that (`eslint.config.js`). Each later step adds the members its tools need
// (W1: status, pending choices, transcripts; W2: prompts, sessions, notes; …).

export interface ProjectRef {
  id: string;
  name: string;
  rootPath: string;
}

/** A session's live phase, or `offline` when no session is running. */
export type SessionPhase =
  "idle" | "working" | "needs_you" | "done" | "ended" | "offline";

export interface SessionRef {
  id: string;
  projectId: string;
  title: string;
  taskNote: string;
  phase: SessionPhase;
}

export interface WorkbenchPort {
  listProjects(): ProjectRef[];
  listSessions(projectId?: string): SessionRef[];
}
