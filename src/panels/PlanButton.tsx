// "open plan" in a console's header (step P1): shown once the session has proposed
// a plan, opens the latest one beside the console; ▾ lists the earlier ones.
// Nothing opens without a click.

import { useEffect } from "react";

import ContextMenu from "../components/ContextMenu";
import { useContextMenu } from "../components/useContextMenu";
import { usePendingChoice } from "../state/pendingChoice";
import { refreshPlans, usePlans } from "../state/plans";
import { openPlan } from "./openPlan";

/** When to look again after a plan approval prompt appears. */
const RETRY_MS = [1000, 3000, 8000];

function PlanButton({ instanceId, enabled }: { instanceId: string; enabled: boolean }) {
  const plans = usePlans(instanceId);
  const pending = usePendingChoice(instanceId);
  const askingPlan = pending?.kind === "plan";
  const { anchor, openMenu, closeMenu } = useContextMenu();

  // Look for plans when the console shows up, and when the session asks to approve
  // one: the only times there can be a new one. The ask can reach us a moment
  // before the plan's line reaches the transcript file, so look again shortly.
  useEffect(() => {
    if (!enabled) return;
    void refreshPlans(instanceId);
    if (!askingPlan) return;
    const timers = RETRY_MS.map((ms) => setTimeout(() => void refreshPlans(instanceId), ms));
    return () => timers.forEach(clearTimeout);
  }, [instanceId, enabled, askingPlan]);

  if (!enabled || plans.length === 0) return null;
  const latest = plans[plans.length - 1];
  return (
    <span style={{ display: "flex", alignItems: "center" }}>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => openPlan(instanceId, latest)}
        title={`open the plan beside the console: ${latest.title}`}
        style={buttonStyle}
      >
        open plan
      </button>
      {plans.length > 1 && (
        <button
          type="button"
          aria-label="earlier plans"
          title={`${plans.length} plans in this session`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) =>
            openMenu(
              e,
              [...plans].reverse().map((p, i) => ({
                label: p.title,
                hint: i === 0 ? "latest" : p.timestamp ? new Date(p.timestamp).toLocaleTimeString() : undefined,
                onClick: () => openPlan(instanceId, p),
              })),
            )
          }
          style={{ ...buttonStyle, borderLeft: "none", padding: "0 4px" }}
        >
          ▾
        </button>
      )}
      {anchor && <ContextMenu {...anchor} onClose={closeMenu} />}
    </span>
  );
}

const buttonStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--wb-border)",
  color: "var(--wb-accent)",
  font: "10.5px var(--wb-mono)",
  cursor: "pointer",
  padding: "0 7px",
  lineHeight: 1.5,
};

export default PlanButton;
