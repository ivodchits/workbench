// The desktop's transcript transport (step T3): the T1 commands and events for one
// instance. Apart from `feed.ts` so the phone's bundle, which shares the feed, pulls
// in no Tauri code.

import {
  followTranscript,
  onTranscriptAppended,
  onTranscriptRotated,
  readTranscriptBack,
  unfollowTranscript,
} from "../ipc/transcript";
import type { TranscriptSource } from "./feed";

export function instanceSource(instanceId: string): TranscriptSource {
  return {
    follow: () => followTranscript(instanceId),
    unfollow: () => void unfollowTranscript(instanceId).catch(() => {}),
    readBack: (before) => readTranscriptBack(instanceId, before),
    onAppended: (cb) =>
      onTranscriptAppended((e) => {
        if (e.instanceId === instanceId) cb(e);
      }),
    onRotated: (cb) =>
      onTranscriptRotated((e) => {
        if (e.instanceId === instanceId) cb(e);
      }),
  };
}
