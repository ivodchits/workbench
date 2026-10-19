// The in-process `WorkbenchPort` (step A2): Duck's view of the app, over the existing
// stores. The only file under `src/assistant/` that may import `src/state/**` or
// `src/panels/**` (ESLint enforces it).

import { getSpend } from "../ipc/assistant";
import {
  gitBranches,
  gitLog,
  gitRepoState,
  gitStatusEntries,
} from "../ipc/git";
import { notesList, notesRead } from "../ipc/notes";
import { readTranscriptBack } from "../ipc/transcript";
import { getUsageLimits } from "../ipc/usageLimits";
import { getPendingChoice, type PendingChoice } from "../state/pendingChoice";
import { getRegistry } from "../state/registry";
import { getLiveStatuses } from "../state/status";
import type { ChoiceRef, WorkbenchPort } from "./port";

function choiceRef(p: PendingChoice): ChoiceRef {
  return {
    kind: p.kind,
    toolName: p.toolName,
    input: p.input,
    at: p.at,
    questions: p.questions,
    options: p.options,
    terminalOnly: p.terminalOnly,
    sent: p.sent?.label ?? null,
  };
}

export const localPort: WorkbenchPort = {
  listProjects() {
    const { projects, groups } = getRegistry();
    return projects.map((p) => ({
      id: p.id,
      name: p.name,
      rootPath: p.rootPath,
      group: groups.find((g) => g.id === p.groupId)?.name ?? null,
      remote: p.remoteSshDest != null,
    }));
  },
  listSessions(projectId) {
    const live = getLiveStatuses();
    return getRegistry()
      .instances.filter((i) => !projectId || i.projectId === projectId)
      .map((i) => {
        const s = live.get(i.id);
        const choice = getPendingChoice(i.id);
        return {
          id: i.id,
          projectId: i.projectId,
          title: i.title,
          taskNote: i.taskNote,
          phase: s?.phase ?? "offline",
          compacting: s?.compacting ?? false,
          subagents: s?.subagents ?? 0,
          worktreeBranch: i.worktreeOn ? i.branch : null,
          workingDir: i.workingDir,
          lastActivity: s?.updatedAt ?? i.lastActivityAt,
          choice: choice ? choiceRef(choice) : null,
        };
      });
  },
  readTranscriptBack: (instanceId, before) =>
    readTranscriptBack(instanceId, before),
  usageLimits: getUsageLimits,
  async git(dir, { commits, since }) {
    const [branches, status, log, state] = await Promise.all([
      gitBranches(dir),
      gitStatusEntries(dir),
      gitLog(dir, { limit: commits, since: since ?? null }),
      gitRepoState(dir),
    ]);
    return { root: dir, branches, status, log, operation: state.operation };
  },
  listNotes: notesList,
  readNote: notesRead,
  spend: getSpend,
};
