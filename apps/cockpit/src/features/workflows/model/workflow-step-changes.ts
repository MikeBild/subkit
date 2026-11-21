import { sameJsonValue } from "@/lib/json-value";

interface StepChanges {
  added: number;
  removed: number;
  changed: number;
  reordered: boolean;
}

function indexed(steps: readonly unknown[]) {
  const map = new Map<string, unknown>();
  for (const step of steps) {
    if (!step || typeof step !== "object" || !("id" in step) || typeof step.id !== "string")
      continue;
    map.set(step.id, step);
  }
  return map;
}

export function workflowStepChanges(
  before: readonly unknown[],
  after: readonly unknown[],
): StepChanges {
  const previous = indexed(before);
  const next = indexed(after);
  const sharedBefore = [...previous.keys()].filter((id) => next.has(id));
  const sharedAfter = [...next.keys()].filter((id) => previous.has(id));
  return {
    added: [...next.keys()].filter((id) => !previous.has(id)).length,
    removed: [...previous.keys()].filter((id) => !next.has(id)).length,
    changed: sharedBefore.filter((id) => !sameJsonValue(previous.get(id), next.get(id))).length,
    reordered: sharedBefore.some((id, index) => sharedAfter[index] !== id),
  };
}
