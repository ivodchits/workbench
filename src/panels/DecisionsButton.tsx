// "decisions" in a console's header: shown while the session is on autopilot
// (running or paused), opens its decisions log beside the console. Nothing opens
// without a click.

import { useAutopilotBadge } from "../state/autopilotBadges";
import { openDecisions } from "./openDecisions";

function DecisionsButton({ instanceId }: { instanceId: string }) {
  const badge = useAutopilotBadge(instanceId);
  if (!badge) return null;
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => openDecisions(instanceId)}
      title="what Duck decided on this session's autopilot without you, and what it left to you"
      style={{
        background: "transparent",
        border: "1px solid var(--wb-border)",
        color: "var(--wb-accent)",
        font: "10.5px var(--wb-mono)",
        cursor: "pointer",
        padding: "0 7px",
        lineHeight: 1.5,
      }}
    >
      decisions
    </button>
  );
}

export default DecisionsButton;
