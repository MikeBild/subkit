// Authoring-critic gating predicate.
//
// Critic calls cost real tokens; this predicate gates the second-stage
// pass so trivial drafts (one or two steps) don't pay the price. The
// LLM is invoked only when (a) the draft has at least N steps OR
// (b) the conversation has shown drift in recent drafts (warnings
// emitted at dry-run time).
//
// All thresholds are env-overridable so operators can tune without a
// schema bump. Defaults match the issue: min_steps=3, drift-triggered.

const MIN_STEPS_DEFAULT = 3;

function readPositiveInt(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readBool(envName: string, fallback: boolean): boolean {
  const raw = process.env[envName];
  if (raw === undefined) return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

export interface GatingInput {
  /** Number of steps in the candidate draft. */
  stepCount: number;
  /** Count of dry-run warnings observed on the most recent preview, if any. */
  recentDriftCount: number;
}

export interface GatingDecision {
  /** True when the critic should be invoked. */
  run: boolean;
  /** Short tag for telemetry: why the decision was made. */
  reason: "disabled" | "step_count" | "recent_drift" | "below_threshold";
}

/**
 * Pure gating predicate. No DB, no env reads beyond the boot-time
 * defaults captured here. Safe to call from inside tool execution.
 */
export function shouldRunCritic(input: GatingInput): GatingDecision {
  if (!readBool("CRITIC_ENABLED", false)) {
    return { run: false, reason: "disabled" };
  }
  const minSteps = readPositiveInt("CRITIC_MIN_STEPS", MIN_STEPS_DEFAULT);
  if (input.stepCount >= minSteps) {
    return { run: true, reason: "step_count" };
  }
  if (input.recentDriftCount > 0) {
    return { run: true, reason: "recent_drift" };
  }
  return { run: false, reason: "below_threshold" };
}
