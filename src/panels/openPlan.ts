// Opening a plan (step P1): a read-only tab beside the session's console. Only
// ever called from a click.

import { openPanelBeside } from "../state/dock";
import { getRegistry } from "../state/registry";
import { refreshPlans } from "../state/plans";
import type { PlanRef } from "../transcript/feed";
import { flash } from "../util/flash";
import type { PlanPanelParams } from "./PlanPanel";

/** Open `plan` beside `instanceId`'s console, or bring its tab forward. */
export function openPlan(instanceId: string, plan: PlanRef): void {
  const instance = getRegistry().instances.find((i) => i.id === instanceId);
  if (!instance) return;
  const params: PlanPanelParams = {
    planId: plan.id,
    fromInstance: instanceId,
    projectId: instance.projectId,
    title: plan.title,
    source: plan.text,
  };
  openPanelBeside(instanceId, {
    id: `plan:${instanceId}:${plan.id}`,
    component: "plan",
    title: `plan · ${plan.title}`,
    params: { ...params },
  });
}

/** Open the session's latest plan, reading the transcript first (a plan waiting
 *  for approval may be newer than what is known). */
export async function openLatestPlan(instanceId: string): Promise<void> {
  const plans = await refreshPlans(instanceId);
  const latest = plans[plans.length - 1];
  if (latest) openPlan(instanceId, latest);
  else flash("no plan in this session yet");
}
