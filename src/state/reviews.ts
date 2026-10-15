// Reviews by a fresh agent (step A1), per implementing instance: which instance is
// reviewing it, whether it has finished, and the findings it returned, with the
// ones ticked to send back. In memory, like the comments it turns into.

import { useSyncExternalStore } from "react";

import type { Finding } from "./reviewFindings";

export interface Review {
  /** The instance doing the review. */
  reviewerId: string;
  state: "running" | "done";
  /** Null while running, and when the reply had no findings block. */
  findings: Finding[] | null;
  /** Indexes into `findings`. */
  ticked: ReadonlySet<number>;
}

let reviews: ReadonlyMap<string, Review> = new Map();
const listeners = new Set<() => void>();

function put(next: Map<string, Review>): void {
  reviews = next;
  for (const l of listeners) l();
}

export function getReview(instanceId: string): Review | undefined {
  return reviews.get(instanceId);
}

/** The implementing instance a reviewer works for. */
export function reviewedBy(reviewerId: string): string | null {
  for (const [id, r] of reviews) if (r.reviewerId === reviewerId) return id;
  return null;
}

export function beginReview(instanceId: string, reviewerId: string): void {
  const next = new Map(reviews);
  next.set(instanceId, { reviewerId, state: "running", findings: null, ticked: new Set() });
  put(next);
}

/** The reviewer finished. Findings worth acting on start ticked; low ones don't. */
export function finishReview(instanceId: string, findings: Finding[] | null): void {
  const prev = reviews.get(instanceId);
  if (!prev) return;
  const ticked = new Set((findings ?? []).flatMap((f, i) => (f.severity === "low" ? [] : [i])));
  const next = new Map(reviews);
  next.set(instanceId, { ...prev, state: "done", findings, ticked });
  put(next);
}

export function toggleFinding(instanceId: string, index: number): void {
  const prev = reviews.get(instanceId);
  if (!prev) return;
  const ticked = new Set(prev.ticked);
  if (ticked.has(index)) ticked.delete(index);
  else ticked.add(index);
  const next = new Map(reviews);
  next.set(instanceId, { ...prev, ticked });
  put(next);
}

export function dropReview(instanceId: string): void {
  if (!reviews.has(instanceId)) return;
  const next = new Map(reviews);
  next.delete(instanceId);
  put(next);
}

export function useReview(instanceId: string): Review | undefined {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => reviews.get(instanceId),
  );
}
