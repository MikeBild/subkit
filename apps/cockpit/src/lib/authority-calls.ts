// One approval can cover more than one workflow: a `call` step starts another,
// and everything that one does happens under this approval too.
//
// The reviewer has to see that as what it is — a separate workflow with its own
// permissions — rather than as a longer list of this workflow's own. Grouping
// is by call path, never by step id: a parent and a child may both call a step
// `publish` against different targets, and merging those two would show one
// permission where two were being granted.

import type { components } from "../api/schema";

type Manifest = components["schemas"]["WorkflowEffectManifest"];
type Shape = components["schemas"]["AuthorityExecutionShape"];
type Effect = Manifest["effects"][number];

export interface AuthorityCallGroup {
  /** The call step this group came through; null for the workflow's own. */
  step_id: string | null;
  workflow_name: string | null;
  version: number | null;
  effects: Effect[];
}

/** A stable React key for anything addressed by (call path, step id). Two
 *  steps that share an id in different workflows must not share a key. */
export function effectKey(call_path: string[] | undefined, step_id: string): string {
  return JSON.stringify([call_path ?? [], step_id]);
}

/**
 * Own effects first, then one group per call step, ordered by step id — the
 * same order the manifest itself is sorted in, so the dialog reads in the
 * order the approval is written.
 *
 * A group is produced for every call the manifest pins, even one whose child
 * contributed no effects: "this run starts that workflow" is itself part of
 * what is being approved.
 */
export function groupByCall(
  manifest: Manifest | null | undefined,
  shape: Shape | null | undefined,
): AuthorityCallGroup[] {
  const effects = manifest?.effects ?? [];
  const own = effects.filter((effect) => !effect.call_path?.length);
  const groups: AuthorityCallGroup[] = [
    { step_id: null, workflow_name: null, version: null, effects: own },
  ];
  const named = new Map((shape?.calls ?? []).map((call) => [call.step_id, call]));
  const pinned = manifest?.calls ?? [];
  const steps =
    pinned.length > 0
      ? pinned.map((pin) => pin.step_id)
      : // Defensive: a manifest without pins can still carry folded effects if a
        // future compiler changes where pins live. Fall back to what the effects
        // themselves say rather than dropping them from the review.
        [...new Set(effects.flatMap((effect) => effect.call_path?.slice(0, 1) ?? []))].sort();
  for (const step_id of steps) {
    const call = named.get(step_id);
    groups.push({
      step_id,
      workflow_name: call?.workflow_name ?? call?.workflow_slug ?? null,
      version: call?.version ?? null,
      effects: effects.filter((effect) => effect.call_path?.[0] === step_id),
    });
  }
  return groups;
}

/** Every request block in the shape that belongs to one group. */
export function requestsOfCall(shape: Shape | null | undefined, step_id: string | null) {
  return (shape?.requests ?? []).filter((request) =>
    step_id === null ? !request.call_path?.length : request.call_path?.[0] === step_id,
  );
}
