// A one-line note under the MCP and Skills managers' headers when the project runs
// on a Claude profile other than Personal (profiles plan P2.2): which profile, and
// what of the listing comes from its config dir.

import type { ClaudeProfile } from "../ipc/profiles";

export default function ProfileBanner({ profile, what }: { profile: ClaudeProfile; what: string }) {
  return (
    <div
      title={profile.configDir}
      style={{
        flex: "0 0 auto",
        padding: "4px 12px",
        borderBottom: "1px solid var(--wb-border)",
        font: "11px var(--wb-mono)",
        color: "var(--wb-textDim2)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      claude profile <span style={{ color: "var(--wb-text)" }}>{profile.name}</span> · {what} from{" "}
      {profile.configDir}
      {!profile.loggedIn && <span style={{ color: "var(--wb-needs)" }}> · not logged in</span>}
    </div>
  );
}
