import type { components } from "../api/schema";

type Manifest = components["schemas"]["WorkflowEffectManifest"];
type Shape = components["schemas"]["AuthorityExecutionShape"];
type Effect = Manifest["effects"][number];

export interface AuthorityCallGroup {
  step_id: string | null;
  workflow_name: string | null;
  version: number | null;
  effects: Effect[];
}

export function effectKey(call_path: string[] | undefined, step_id: string): string {
  return JSON.stringify([call_path ?? [], step_id]);
}

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
      : [...new Set(effects.flatMap((effect) => effect.call_path?.slice(0, 1) ?? []))].sort();
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

export function requestsOfCall(shape: Shape | null | undefined, step_id: string | null) {
  return (shape?.requests ?? []).filter((request) =>
    step_id === null ? !request.call_path?.length : request.call_path?.[0] === step_id,
  );
}
