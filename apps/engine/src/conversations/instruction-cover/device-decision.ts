import type { AssembledStep } from "../core/device-tools/step.ts";
import {
  boundaryRefusal,
  decideJobStep,
  type JobDecision,
  type JobRequest,
  type JobState,
} from "./job.ts";

export type DeviceToolDecision =
  | JobDecision
  | { readonly decision: "ask"; readonly reason: "ask_before_writing" };

export function decideDeviceTool(p: {
  readonly request: JobRequest;
  readonly job: JobState;
  readonly assembled: AssembledStep;
  readonly ask_before_writing: boolean;
  readonly now: Date;
}): DeviceToolDecision {
  const { step, other_paths, blocked } = p.assembled;
  if (blocked !== null)
    return { decision: "refuse", reason: "outside_device_boundary", detail: blocked };
  for (const path of other_paths) {
    const outside = boundaryRefusal(p.job.device, { ...step, path: { lexical: path, real: path } });
    if (outside !== null)
      return { decision: "refuse", reason: "outside_device_boundary", detail: outside };
  }
  const decided = decideJobStep(p.request, p.job, step, p.now);
  if (!p.ask_before_writing || step.phase === "read") return decided;
  return decided.decision === "refuse"
    ? decided
    : { decision: "ask", reason: "ask_before_writing" };
}
