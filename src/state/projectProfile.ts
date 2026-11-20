// The Claude profile a project runs under (profiles plan P2.2), for the panels that
// act for a project (MCP, skills): its id, name and config dir. Personal (no
// profile) comes back as `null`.

import { useEffect, useState } from "react";

import { listProfiles, type ClaudeProfile } from "../ipc/profiles";
import { useRegistry } from "./registry";

export function useProjectProfile(projectId: string): ClaudeProfile | null {
  const { projects } = useRegistry();
  const profileId = projects.find((p) => p.id === projectId)?.profileId ?? null;
  const [profile, setProfile] = useState<ClaudeProfile | null>(null);
  useEffect(() => {
    if (!profileId) {
      setProfile(null);
      return;
    }
    let live = true;
    void listProfiles()
      .then((all) => {
        if (live) setProfile(all.find((p) => p.id === profileId) ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [profileId]);
  return profileId ? profile : null;
}
