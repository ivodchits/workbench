// Running project toolbar actions (step K1): from a button, the palette or a task
// panel's "run again". An action runs in its task panel; running it again reuses
// the panel, asking first when the previous run is still going. A `confirm`
// question is asked before anything runs.
//
// Questions go through `askConfirm`, answered by the `ConfirmHost` the toolbar
// keeps mounted, so the palette and a task panel can ask too.

import { useMemo, useSyncExternalStore } from "react";

import { pluginsInit, type Plugin, type PluginAction } from "../ipc/plugins";
import { ptyKill } from "../ipc/pty";
import { getRegistry } from "../state/registry";
import { openProjectFile } from "../state/editors";
import { setActiveProject, useActiveProject } from "../state/activeProject";
import { getPluginsView, loadPlugins, storedValues, usePluginsState } from "../state/plugins";
import { actionTitle, blockingFields, fillForDisplay, runValues, taskIdFor } from "../state/pluginModel";
import { getTask, isLive, markTaskStopped, startTask } from "../state/tasks";
import { flash } from "../util/flash";
import { release } from "./terminalPool";

// --- confirm questions ----------------------------------------------------------

interface Question {
  text: string;
  yes: string;
  resolve: (ok: boolean) => void;
}

let question: Question | null = null;
const listeners = new Set<() => void>();

function setQuestion(q: Question | null): void {
  question = q;
  for (const l of listeners) l();
}

/** Ask a yes/no question; resolves false when dismissed. One at a time: a second
 *  question while one is open answers the first "no". */
export function askConfirm(text: string, yes = "run"): Promise<boolean> {
  question?.resolve(false);
  return new Promise((resolve) => setQuestion({ text, yes, resolve }));
}

export function answerQuestion(ok: boolean): void {
  const q = question;
  setQuestion(null);
  q?.resolve(ok);
}

export function useQuestion(): Question | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => question,
  );
}

// --- runs -----------------------------------------------------------------------

/** Find a plugin and action in a project's last-read file. */
function lookup(projectId: string, pluginId: string, actionId: string): { plugin: Plugin; action: PluginAction } | null {
  const plugin = getPluginsView(projectId)?.file?.plugins.find((p) => p.id === pluginId);
  const action = plugin?.actions.find((a) => a.id === actionId);
  return plugin && action ? { plugin, action } : null;
}

/** Run an action with its plugin's current field values. */
export async function runPluginAction(projectId: string, pluginId: string, actionId: string): Promise<void> {
  // A dormant panel's "run" can come before the toolbar ever read the file.
  if (!getPluginsView(projectId)) await loadPlugins(projectId);
  const found = lookup(projectId, pluginId, actionId);
  if (!found) {
    flash(`the plugin file has no action ${pluginId}: ${actionId} any more`);
    return;
  }
  const { plugin, action } = found;
  const stored = storedValues(projectId, plugin.id);
  const blocked = blockingFields(plugin, stored);
  if (blocked.length > 0) {
    flash(`${blocked.join(", ")}: the value doesn't match its pattern`);
    return;
  }
  const title = actionTitle(plugin, action);
  if (action.confirm && !(await askConfirm(fillForDisplay(action.confirm, plugin, stored)))) return;

  const taskId = taskIdFor(projectId, plugin.id, action.id);
  const previous = getTask(taskId);
  if (isLive(previous)) {
    if (!(await askConfirm(`${title} is still running. Stop it and run it again?`, "stop and run"))) return;
  }
  startRun(projectId, plugin, action, runValues(plugin, stored));
}

/** Start a run in the action's task panel (made if needed, brought to front). */
function startRun(
  projectId: string,
  plugin: Plugin,
  action: PluginAction,
  values: Record<string, string>,
  revision?: string,
): string {
  const taskId = taskIdFor(projectId, plugin.id, action.id);
  // The previous run's terminal goes (and with it any PTY still running); the new
  // run gets a fresh one in the same panel.
  release(taskId);
  startTask(
    { taskId, projectId, pluginId: plugin.id, actionId: action.id, label: actionTitle(plugin, action), long: action.long },
    { projectId, pluginId: plugin.id, actionId: action.id, values, ...(revision && { revision }) },
  );
  return taskId;
}

/** Duck's run (assistant plan W5), already confirmed on its card: no `confirm`
 *  question, and refused while a run is going. The panel is drawn for the shown
 *  project only, so the project is shown first. `revision` pins the file to the
 *  one the card showed. Returns the task id and its run number. */
export async function startPluginRunFor(
  projectId: string,
  pluginId: string,
  actionId: string,
  values: Record<string, string>,
  revision: string,
): Promise<{ taskId: string; run: number; label: string }> {
  await loadPlugins(projectId);
  const found = lookup(projectId, pluginId, actionId);
  if (!found) throw new Error(`the plugin file has no action ${pluginId}: ${actionId} any more`);
  const { plugin, action } = found;
  const taskId = taskIdFor(projectId, plugin.id, action.id);
  if (isLive(getTask(taskId)))
    throw new Error(`${actionTitle(plugin, action)} is still running. Ask the user to stop it first, or wait for it to end.`);
  setActiveProject(projectId);
  startRun(projectId, plugin, action, values, revision);
  return { taskId, run: getTask(taskId)?.run ?? 0, label: actionTitle(plugin, action) };
}

/** Stop a running task, keeping its output on screen. */
export function stopTask(taskId: string): void {
  if (!isLive(getTask(taskId))) return;
  markTaskStopped(taskId);
  void ptyKill(taskId);
}

/** A palette entry for each of the active project's actions ("build: installer"). */
export interface PluginCommand {
  id: string;
  title: string;
  run: () => void;
}

export function usePluginCommands(): PluginCommand[] {
  const projectId = useActiveProject();
  const { views } = usePluginsState();
  const file = projectId ? views[projectId]?.file : null;
  return useMemo(
    () =>
      !projectId || !file
        ? []
        : file.plugins.flatMap((plugin) =>
            plugin.actions.map((action) => ({
              id: taskIdFor(projectId, plugin.id, action.id),
              title: actionTitle(plugin, action),
              run: () => void runPluginAction(projectId, plugin.id, action.id),
            })),
          ),
    [projectId, file],
  );
}

/** Open the project's plugin file in the editor, making it first if needed. */
export async function editPlugins(projectId: string): Promise<void> {
  const project = getRegistry().projects.find((p) => p.id === projectId);
  try {
    const path = await pluginsInit(projectId);
    openProjectFile(
      { projectId, rootPath: project?.rootPath ?? path, label: project?.name ?? "plugins" },
      { path },
    );
  } catch (e) {
    flash(`can't open the plugin file: ${String(e)}`);
  }
}
